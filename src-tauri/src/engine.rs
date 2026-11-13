use crate::{
    browser::{Probe, QuerySource},
    model::*,
    storage::Storage,
};
use chrono::Utc;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::Mutex,
    time::{sleep, Instant},
};

const RUN: u8 = 0;
const PAUSE: u8 = 1;
const CANCEL: u8 = 2;
const SKIP: u8 = 3;
type Emitter = Arc<dyn Fn(Snapshot) + Send + Sync>;
struct State {
    data: Data,
    job: Job,
}
pub struct Engine {
    state: Mutex<State>,
    storage: Storage,
    data_dir: PathBuf,
    source: Arc<dyn QuerySource>,
    emit: Emitter,
    running: AtomicBool,
    control: AtomicU8,
    stopping: AtomicBool,
}
impl Engine {
    pub fn new(
        data_dir: PathBuf,
        source: Arc<dyn QuerySource>,
        emit: Emitter,
    ) -> Result<Arc<Self>, String> {
        let storage = Storage::new(&data_dir);
        let data = storage.load()?;
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                data,
                job: Job::default(),
            }),
            storage,
            data_dir,
            source,
            emit,
            running: AtomicBool::new(false),
            control: AtomicU8::new(RUN),
            stopping: AtomicBool::new(false),
        }))
    }
    fn snapshot_of(&self, state: &State) -> Snapshot {
        Snapshot {
            shipments: state.data.shipments.clone(),
            settings: state.data.settings.clone(),
            job: state.job.clone(),
            data_dir: self.data_dir.to_string_lossy().into_owned(),
        }
    }
    pub async fn snapshot(&self) -> Snapshot {
        self.snapshot_of(&*self.state.lock().await)
    }
    async fn change<R>(
        &self,
        persist: bool,
        f: impl FnOnce(&mut Data, &mut Job) -> Result<R, String>,
    ) -> Result<R, String> {
        let mut state = self.state.lock().await;
        // Commit memory and disk together; a failed save must never look successful in the UI.
        let mut data = state.data.clone();
        let mut job = state.job.clone();
        let result = f(&mut data, &mut job)?;
        if persist {
            self.storage.save(&data)?;
        }
        state.data = data;
        state.job = job;
        (self.emit)(self.snapshot_of(&state));
        Ok(result)
    }
    pub async fn import(&self, rows: Vec<ImportRow>) -> Result<ImportResult, String> {
        if rows.len() > 1000 {
            return Err("每批最多导入 1000 个运单".into());
        }
        self.change(true, |data, _| {
            let mut existing: HashSet<String> =
                data.shipments.iter().map(|s| s.number.clone()).collect();
            let mut result = ImportResult::default();
            for row in rows {
                if let Some(row) = row.normalize() {
                    if !existing.insert(row.number.clone()) {
                        result.duplicates += 1;
                        continue;
                    }
                    data.shipments.insert(0, Shipment::from_row(row));
                    result.added += 1;
                } else {
                    result.invalid += 1;
                }
            }
            if data.shipments.len() > 10000 {
                return Err("最多保留 10000 个运单，请导出并删除已完成记录后再导入".into());
            }
            Ok(result)
        })
        .await
    }
    pub async fn update(
        &self,
        id: String,
        note: String,
        tracking: bool,
        carrier: String,
    ) -> Result<(), String> {
        let normalized = ImportRow {
            number: "VALID123".into(),
            carrier,
            note,
        }
        .normalize()
        .ok_or("快递公司编码格式不正确")?;
        self.change(true, |data, job| {
            if job.phase.active() && job.current_id.as_deref() == Some(&id) {
                return Err("此运单正在查询，请先结束查询后再编辑".into());
            }
            let shipment = data
                .shipments
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("运单已不存在")?;
            if shipment.carrier != normalized.carrier {
                shipment.carrier_name.clear();
            }
            shipment.note = normalized.note;
            shipment.tracking = tracking;
            shipment.carrier = normalized.carrier;
            Ok(())
        })
        .await
    }
    pub async fn remove(&self, ids: Vec<String>) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Err("请先结束当前批次，再删除运单".into());
        }
        self.change(true, |data, job| {
            if job.phase.active() {
                return Err("请先结束当前批次，再删除运单".into());
            }
            data.shipments.retain(|s| !ids.contains(&s.id));
            Ok(())
        })
        .await
    }
    pub async fn settings(&self, settings: Settings) -> Result<(), String> {
        settings.validate()?;
        self.change(true, |data, _| {
            data.settings = settings;
            Ok(())
        })
        .await
    }
    pub async fn open_browser(&self) -> Result<(), String> {
        let path = self.state.lock().await.data.settings.browser_path.clone();
        self.source.show(&path).await
    }
    pub async fn start(self: &Arc<Self>, ids: Vec<String>) -> Result<(), String> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err("应用正在关闭".into());
        }
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("已有查询批次正在运行".into());
        }
        let requested: HashSet<_> = ids.into_iter().collect();
        let ids: Vec<String> = self
            .state
            .lock()
            .await
            .data
            .shipments
            .iter()
            .filter(|s| requested.contains(&s.id))
            .map(|s| s.id.clone())
            .collect();
        if ids.is_empty() {
            self.running.store(false, Ordering::SeqCst);
            return Err("请先选择需要查询的运单".into());
        }
        self.control.store(RUN, Ordering::SeqCst);
        if let Err(e) = self
            .change(false, |_, job| {
                *job = Job {
                    phase: Phase::Running,
                    total: ids.len(),
                    started_at: Some(now()),
                    message: "正在打开查询窗口…".into(),
                    ..Job::default()
                };
                Ok(())
            })
            .await
        {
            self.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
        let engine = Arc::clone(self);
        tokio::spawn(async move {
            let result = engine.run_batch(ids).await;
            if let Err(error) = result {
                let _ = engine
                    .change(false, |_, job| {
                        job.phase = Phase::Failed;
                        job.message = error;
                        job.current_id = None;
                        job.current_number = None;
                        Ok(())
                    })
                    .await;
            }
            engine.running.store(false, Ordering::SeqCst);
        });
        Ok(())
    }
    pub async fn control(&self, action: &str) -> Result<(), String> {
        let job = self.state.lock().await.job.clone();
        let phase = job.phase;
        if !phase.active() {
            return Err("当前没有运行中的批次".into());
        }
        let control = match action {
            "pause" if phase == Phase::Running => PAUSE,
            "resume" if matches!(phase, Phase::Paused | Phase::Waiting) => RUN,
            "cancel" => CANCEL,
            "skip"
                if matches!(phase, Phase::Paused | Phase::Waiting) && job.current_id.is_some() =>
            {
                SKIP
            }
            _ => return Err("当前状态不支持此操作".into()),
        };
        self.control.store(control, Ordering::SeqCst);
        self.change(false, |_, job| {
            if control == CANCEL {
                job.phase = Phase::Cancelling;
                job.message = "正在停止，已完成的结果会保留".into();
            }
            if control == RUN {
                job.phase = Phase::Running;
                job.message = "正在继续查询…".into();
            }
            if control == PAUSE {
                job.phase = Phase::Paused;
                job.message = "批次已暂停".into();
            }
            Ok(())
        })
        .await
    }
    async fn wait_control(&self) -> u8 {
        loop {
            let value = self.control.load(Ordering::SeqCst);
            if value != PAUSE {
                return value;
            }
            sleep(Duration::from_millis(150)).await;
        }
    }
    async fn run_batch(&self, ids: Vec<String>) -> Result<(), String> {
        for (index, id) in ids.iter().enumerate() {
            let action = self.wait_control().await;
            if action == CANCEL {
                break;
            }
            self.control
                .compare_exchange(SKIP, RUN, Ordering::SeqCst, Ordering::SeqCst)
                .ok();
            let snapshot = self.snapshot().await;
            let Some(shipment) = snapshot.shipments.iter().find(|s| &s.id == id).cloned() else {
                continue;
            };
            self.change(true, |data, job| {
                job.phase = Phase::Running;
                job.current_id = Some(id.clone());
                job.current_number = Some(shipment.number.clone());
                job.message = "正在读取物流信息…".into();
                if let Some(s) = data.shipments.iter_mut().find(|s| &s.id == id) {
                    s.query_state = QueryState::Querying;
                    s.error = None;
                }
                Ok(())
            })
            .await?;
            // Poll cancellation while a page is loading, instead of waiting for the full load timeout.
            let begin = async {
                tokio::time::timeout(
                    Duration::from_secs(35),
                    self.source.begin(
                        &shipment.number,
                        &shipment.carrier,
                        &snapshot.settings.browser_path,
                    ),
                )
                .await
                .map_err(|_| "查询页面加载超时，请检查 Edge 窗口和网络".to_string())?
            };
            tokio::pin!(begin);
            let result = loop {
                tokio::select! {
                    outcome = &mut begin => break outcome,
                    _ = sleep(Duration::from_millis(150)) => {
                        if matches!(self.control.load(Ordering::SeqCst), CANCEL | SKIP) { break Err("查询已中断".into()); }
                    }
                }
            };
            let outcome = if self
                .control
                .compare_exchange(SKIP, RUN, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                Outcome::Skipped("已跳过此单，可以稍后重新查询".into())
            } else {
                match result {
                    Ok(()) => self.read_result(&shipment.number).await,
                    Err(e) => Outcome::Error(e),
                }
            };
            let cancelled = self.control.load(Ordering::SeqCst) == CANCEL;
            self.change(true, |data, job| {
                if let Some(s) = data.shipments.iter_mut().find(|s| &s.id == id) {
                    if cancelled {
                        s.query_state = QueryState::Error;
                        s.error = Some("查询已取消，原有物流记录已保留".into());
                    } else {
                        s.checked_at = Some(now());
                        match outcome {
                            Outcome::Success(mut result) => {
                                result.events.sort_by(|a, b| b.time.cmp(&a.time));
                                s.status = result.status();
                                s.events = result.events;
                                if !result.carrier.is_empty() {
                                    s.carrier = result.carrier;
                                }
                                if !result.carrier_name.is_empty() {
                                    s.carrier_name = result.carrier_name;
                                }
                                s.query_state = QueryState::Success;
                                s.error = None;
                            }
                            Outcome::Error(error) => {
                                s.query_state = QueryState::Error;
                                s.error = Some(error);
                                job.failed += 1;
                            }
                            Outcome::Skipped(message) => {
                                s.query_state = QueryState::Attention;
                                s.error = Some(message);
                                job.skipped += 1;
                            }
                        }
                        job.completed += 1;
                    }
                }
                job.current_id = None;
                job.current_number = None;
                Ok(())
            })
            .await?;
            if cancelled {
                break;
            }
            if index + 1 < ids.len() {
                let delay = self.state.lock().await.data.settings.request_delay_seconds;
                self.change(false, |_, job| {
                    job.message = format!("等待 {delay} 秒后查询下一单…");
                    Ok(())
                })
                .await?;
                let mut elapsed = Duration::ZERO;
                while elapsed < Duration::from_secs(delay as u64) {
                    if self.wait_control().await == CANCEL {
                        break;
                    }
                    sleep(Duration::from_millis(200)).await;
                    elapsed += Duration::from_millis(200);
                }
            }
        }
        self.change(false, |_, job| {
            job.phase = if self.control.load(Ordering::SeqCst) == CANCEL {
                Phase::Cancelled
            } else {
                Phase::Completed
            };
            job.current_id = None;
            job.current_number = None;
            job.message = if job.phase == Phase::Cancelled {
                "批次已停止，已完成的结果已保存".into()
            } else {
                format!(
                    "查询完成：成功 {}，失败 {}，跳过 {}",
                    job.completed.saturating_sub(job.failed + job.skipped),
                    job.failed,
                    job.skipped
                )
            };
            Ok(())
        })
        .await
    }
    async fn read_result(&self, number: &str) -> Outcome {
        let mut active_time = Duration::ZERO;
        loop {
            match self.wait_control().await {
                CANCEL => return Outcome::Error("查询已取消".into()),
                SKIP => {
                    self.control.store(RUN, Ordering::SeqCst);
                    return Outcome::Skipped(
                        "已跳过，请完成网页验证或更换查询方式后手动重试".into(),
                    );
                }
                _ => {}
            }
            let started = Instant::now();
            match self.source.poll(number).await {
                Ok(Probe::Success { result }) => return Outcome::Success(result),
                Ok(Probe::Unavailable { message }) => return Outcome::Skipped(message),
                Ok(Probe::Failure { message }) => return Outcome::Error(message),
                Ok(Probe::Attention { message }) => {
                    self.control
                        .compare_exchange(RUN, PAUSE, Ordering::SeqCst, Ordering::SeqCst)
                        .ok();
                    if self.control.load(Ordering::SeqCst) == CANCEL {
                        return Outcome::Error("查询已取消".into());
                    }
                    if let Err(e) = self
                        .change(true, |data, job| {
                            if let Some(s) = data.shipments.iter_mut().find(|s| s.number == number)
                            {
                                s.query_state = QueryState::Attention;
                                s.error = Some(message.clone());
                            }
                            job.phase = Phase::Waiting;
                            job.message = message;
                            Ok(())
                        })
                        .await
                    {
                        return Outcome::Error(e);
                    }
                    active_time = Duration::ZERO;
                }
                Ok(Probe::Pending) => {}
                Err(error) => return Outcome::Error(error),
            }
            active_time += started.elapsed();
            if active_time >= Duration::from_secs(45) {
                return Outcome::Error("等待物流结果超时，请查看 Edge 页面后重试".into());
            }
            sleep(Duration::from_millis(700)).await;
            active_time += Duration::from_millis(700);
        }
    }
    pub fn spawn_scheduler(self: &Arc<Self>) {
        let engine = Arc::clone(self);
        tokio::spawn(async move {
            while !engine.stopping.load(Ordering::SeqCst) {
                sleep(Duration::from_secs(30)).await;
                if engine.running.load(Ordering::SeqCst) {
                    continue;
                }
                let snapshot = engine.snapshot().await;
                if !snapshot.settings.auto_track {
                    continue;
                }
                let now = Utc::now();
                let ids = snapshot
                    .shipments
                    .iter()
                    .filter(|s| s.due(&snapshot.settings, now))
                    .map(|s| s.id.clone())
                    .collect::<Vec<_>>();
                if !ids.is_empty() {
                    let _ = engine.start(ids).await;
                }
            }
        });
    }
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.control.store(CANCEL, Ordering::SeqCst);
        self.source.shutdown().await;
    }
}
enum Outcome {
    Success(QueryResult),
    Error(String),
    Skipped(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    struct TestSource {
        attention: AtomicBool,
        fail: AtomicBool,
    }
    #[async_trait]
    impl QuerySource for TestSource {
        async fn begin(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn poll(&self, _: &str) -> Result<Probe, String> {
            if self.attention.load(Ordering::SeqCst) {
                return Ok(Probe::Attention {
                    message: "请验证".into(),
                });
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err("网络中断".into());
            }
            Ok(Probe::Success {
                result: QueryResult {
                    carrier: "shunfeng".into(),
                    carrier_name: "顺丰速运".into(),
                    state: "3".into(),
                    events: vec![TrackingEvent {
                        time: "2026-11-13 12:00:00".into(),
                        context: "已签收".into(),
                        location: "".into(),
                    }],
                },
            })
        }
        async fn show(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn shutdown(&self) {}
    }
    async fn finished(engine: &Engine) {
        tokio::time::timeout(Duration::from_secs(8), async {
            while engine.running.load(Ordering::SeqCst) {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    fn row(number: &str) -> ImportRow {
        ImportRow {
            number: number.into(),
            carrier: "".into(),
            note: "".into(),
        }
    }
    #[tokio::test]
    async fn duplicate_import_and_query_failure_preserve_previous_logistics() {
        let dir = tempfile::tempdir().unwrap();
        let source = Arc::new(TestSource {
            attention: AtomicBool::new(false),
            fail: AtomicBool::new(false),
        });
        let engine = Engine::new(dir.path().into(), source.clone(), Arc::new(|_| {})).unwrap();
        let imported = engine
            .import(vec![row("SF12345678"), row("sf12345678"), row("invalid!")])
            .await
            .unwrap();
        assert_eq!(
            (imported.added, imported.duplicates, imported.invalid),
            (1, 1, 1)
        );
        let id = engine.snapshot().await.shipments[0].id.clone();
        engine.start(vec![id.clone()]).await.unwrap();
        finished(&engine).await;
        source.fail.store(true, Ordering::SeqCst);
        engine.start(vec![id]).await.unwrap();
        finished(&engine).await;
        let snapshot = engine.snapshot().await;
        assert_eq!(snapshot.shipments[0].status, ShipmentStatus::Delivered);
        assert_eq!(snapshot.shipments[0].events.len(), 1);
        assert_eq!(snapshot.shipments[0].query_state, QueryState::Error);
        assert_eq!(snapshot.job.failed, 1);
    }
    #[tokio::test]
    async fn manual_verification_pauses_and_skip_finishes_without_fabricating_events() {
        let dir = tempfile::tempdir().unwrap();
        let source = Arc::new(TestSource {
            attention: AtomicBool::new(true),
            fail: AtomicBool::new(false),
        });
        let engine = Engine::new(dir.path().into(), source, Arc::new(|_| {})).unwrap();
        engine.import(vec![row("SF12345678")]).await.unwrap();
        let id = engine.snapshot().await.shipments[0].id.clone();
        engine.start(vec![id.clone()]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while engine.snapshot().await.job.phase != Phase::Waiting {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(engine.start(vec![id]).await.is_err());
        engine.control("skip").await.unwrap();
        finished(&engine).await;
        let snapshot = engine.snapshot().await;
        assert_eq!(snapshot.job.skipped, 1);
        assert_eq!(snapshot.shipments[0].query_state, QueryState::Attention);
        assert!(snapshot.shipments[0].events.is_empty());
    }
    #[tokio::test]
    async fn verification_can_resume_into_a_successful_result() {
        let dir = tempfile::tempdir().unwrap();
        let source = Arc::new(TestSource {
            attention: AtomicBool::new(true),
            fail: AtomicBool::new(false),
        });
        let engine = Engine::new(dir.path().into(), source.clone(), Arc::new(|_| {})).unwrap();
        engine.import(vec![row("SF12345678")]).await.unwrap();
        let id = engine.snapshot().await.shipments[0].id.clone();
        engine.start(vec![id]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while engine.snapshot().await.job.phase != Phase::Waiting {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        source.attention.store(false, Ordering::SeqCst);
        engine.control("resume").await.unwrap();
        finished(&engine).await;
        let snapshot = engine.snapshot().await;
        assert_eq!(snapshot.job.completed, 1);
        assert_eq!(snapshot.job.failed + snapshot.job.skipped, 0);
        assert_eq!(snapshot.shipments[0].status, ShipmentStatus::Delivered);
        assert_eq!(snapshot.shipments[0].query_state, QueryState::Success);
    }
    #[tokio::test]
    async fn cancellation_while_waiting_keeps_completed_count_honest() {
        let dir = tempfile::tempdir().unwrap();
        let source = Arc::new(TestSource {
            attention: AtomicBool::new(true),
            fail: AtomicBool::new(false),
        });
        let engine = Engine::new(dir.path().into(), source, Arc::new(|_| {})).unwrap();
        engine.import(vec![row("SF12345678")]).await.unwrap();
        let id = engine.snapshot().await.shipments[0].id.clone();
        engine.start(vec![id]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while engine.snapshot().await.job.phase != Phase::Waiting {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        engine.control("cancel").await.unwrap();
        finished(&engine).await;
        let snapshot = engine.snapshot().await;
        assert_eq!(snapshot.job.phase, Phase::Cancelled);
        assert_eq!(snapshot.job.completed, 0);
        assert_ne!(snapshot.shipments[0].query_state, QueryState::Querying);
    }
}
