use crate::model::QueryResult;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::Mutex,
    time::{sleep, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Probe {
    Pending,
    Success { result: QueryResult },
    Attention { message: String },
    Unavailable { message: String },
    Failure { message: String },
}

#[async_trait]
pub trait QuerySource: Send + Sync {
    async fn begin(&self, number: &str, carrier: &str, browser_path: &str) -> Result<(), String>;
    async fn poll(&self, number: &str) -> Result<Probe, String>;
    async fn show(&self, browser_path: &str) -> Result<(), String>;
    async fn shutdown(&self);
}

pub struct BrowserSource {
    profile_dir: PathBuf,
    session: Mutex<Option<Session>>,
}
struct Session {
    process: Child,
    cdp: Cdp,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}
impl BrowserSource {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            profile_dir: data_dir.join("edge-profile"),
            session: Mutex::new(None),
        }
    }
    async fn launch(&self, browser_path: &str) -> Result<Session, String> {
        let executable = find_browser(browser_path)?;
        std::fs::create_dir_all(&self.profile_dir)
            .map_err(|e| format!("无法创建浏览器配置目录：{e}"))?;
        let active_port_file = self.profile_dir.join("DevToolsActivePort");
        // Only our dedicated profile is used; personal Edge profiles are untouched.
        let _ = std::fs::remove_file(&active_port_file);
        let mut command = Command::new(executable);
        command
            .args([
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--no-first-run",
                "--no-default-browser-check",
                "--new-window",
            ])
            .arg(format!("--user-data-dir={}", self.profile_dir.display()))
            .arg("https://www.kuaidi100.com/")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // No console window; Edge itself remains visible.
        }
        let mut process = command.spawn().map_err(|e| format!("无法启动 Edge：{e}"))?;
        let result = async {
            let mut port = None;
            for _ in 0..100 {
                if let Some(status) = process.try_wait().map_err(|e| e.to_string())? {
                    return Err(format!(
                        "浏览器启动后退出（{status}），请关闭运单工作台专用 Edge 窗口后重试"
                    ));
                }
                if let Ok(text) = std::fs::read_to_string(&active_port_file) {
                    port = text
                        .lines()
                        .next()
                        .and_then(|s| s.parse::<u16>().ok())
                        .filter(|p| *p > 0);
                    if port.is_some() {
                        break;
                    }
                }
                sleep(Duration::from_millis(150)).await;
            }
            let port = port.ok_or("未能连接浏览器，请检查 Edge 是否可正常启动")?;
            // This client only talks to the browser's loopback debugging endpoint.
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|e| e.to_string())?;
            let targets: Vec<Value> = client
                .get(format!("http://127.0.0.1:{port}/json/list"))
                .send()
                .await
                .map_err(|e| format!("连接 Edge 失败：{e}"))?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            let target = targets
                .iter()
                .find(|t| {
                    t["type"] == "page" && t["url"].as_str().unwrap_or("").contains("kuaidi100.com")
                })
                .or_else(|| targets.iter().find(|t| t["type"] == "page"))
                .ok_or("没有可用的浏览器查询标签页")?;
            let websocket = target["webSocketDebuggerUrl"]
                .as_str()
                .ok_or("浏览器未开放查询连接")?;
            Cdp::connect(websocket).await
        }
        .await;
        match result {
            Ok(cdp) => Ok(Session { process, cdp }),
            Err(error) => {
                let _ = process.kill();
                let _ = process.wait();
                Err(error)
            }
        }
    }
    async fn ensure(
        &self,
        session: &mut Option<Session>,
        browser_path: &str,
    ) -> Result<(), String> {
        if let Some(current) = session.as_mut() {
            if current
                .process
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
                && current
                    .cdp
                    .call("Browser.getVersion", json!({}))
                    .await
                    .is_ok()
            {
                return Ok(());
            }
        }
        *session = None;
        *session = Some(self.launch(browser_path).await?);
        Ok(())
    }
}

#[async_trait]
impl QuerySource for BrowserSource {
    async fn begin(&self, number: &str, carrier: &str, browser_path: &str) -> Result<(), String> {
        let mut guard = self.session.lock().await;
        self.ensure(&mut guard, browser_path).await?;
        let session = guard.as_mut().ok_or("查询窗口未就绪")?;
        let visit = uuid::Uuid::new_v4().to_string();
        session
            .cdp
            .call(
                "Page.navigate",
                json!({ "url": format!("https://www.kuaidi100.com/?package_tracking={visit}") }),
            )
            .await?;
        // Wait for the query form AND the site's own click handlers to be ready.
        let mut ready = false;
        for _ in 0..60 {
            let ready_expression = format!("Boolean(location.hostname === 'www.kuaidi100.com' && new URL(location.href).searchParams.get('package_tracking') === {} && window.jQuery && document.querySelector('#input') && document.querySelector('#query') && window.jQuery._data(document.querySelector('#query'), 'events')?.click)", serde_json::to_string(&visit).map_err(|e| e.to_string())?);
            let value = session.cdp.eval(&ready_expression).await;
            if matches!(value, Ok(Value::Bool(true))) {
                ready = true;
                break;
            }
            sleep(Duration::from_millis(300)).await;
        }
        if !ready {
            return Err("快递100查询页面未加载完成，请检查网络后重试".into());
        }
        let expression = format!(
            r#"(() => {{
            const input = document.querySelector('#input');
            input.value = {};
            input.dispatchEvent(new Event('input', {{ bubbles: true }}));
            const carrier = {};
            const choice = [...document.querySelectorAll('#comlist a[data-code]')].find(el => el.dataset.code === carrier);
            if (carrier && !choice) return 'unknown_carrier';
            if (choice) choice.click(); else document.querySelector('#query').click();
            return 'submitted';
        }})()"#,
            serde_json::to_string(number).map_err(|e| e.to_string())?,
            serde_json::to_string(carrier).map_err(|e| e.to_string())?
        );
        if session.cdp.eval(&expression).await? == "unknown_carrier" {
            return Err("网页不支持指定的快递公司，请在运单详情中改为自动识别后重试".into());
        }
        Ok(())
    }
    async fn poll(&self, number: &str) -> Result<Probe, String> {
        let mut guard = self.session.lock().await;
        let session = guard.as_mut().ok_or("查询窗口已关闭，请重新查询")?;
        let expression = format!(
            "({})({})",
            include_str!("probe.js"),
            serde_json::to_string(number).map_err(|e| e.to_string())?
        );
        let value = session.cdp.eval(&expression).await?;
        serde_json::from_value(value).map_err(|e| format!("查询页面结构不兼容：{e}"))
    }
    async fn show(&self, browser_path: &str) -> Result<(), String> {
        let mut guard = self.session.lock().await;
        self.ensure(&mut guard, browser_path).await?;
        guard
            .as_mut()
            .ok_or("查询窗口未就绪")?
            .cdp
            .call("Page.bringToFront", json!({}))
            .await?;
        Ok(())
    }
    async fn shutdown(&self) {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_mut() {
            let _ = session.cdp.call("Browser.close", json!({})).await;
        }
        *guard = None;
    }
}

fn find_browser(configured: &str) -> Result<PathBuf, String> {
    if !configured.trim().is_empty() {
        let path = PathBuf::from(configured.trim().trim_matches('"'));
        return if path.is_file() {
            Ok(path)
        } else {
            Err("设置中的浏览器路径不存在，请选择 msedge.exe 或 chrome.exe".into())
        };
    }
    let mut paths = vec![];
    for root in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(root) {
            paths.push(PathBuf::from(&value).join("Microsoft/Edge/Application/msedge.exe"));
            paths.push(PathBuf::from(value).join("Google/Chrome/Application/chrome.exe"));
        }
    }
    paths
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "未找到 Microsoft Edge。请先安装 Edge，或在设置中填写浏览器完整路径".into())
}

struct Cdp {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}
impl Cdp {
    async fn connect(url: &str) -> Result<Self, String> {
        let (socket, _) = timeout(Duration::from_secs(8), connect_async(url))
            .await
            .map_err(|_| "连接浏览器超时".to_string())?
            .map_err(|e| format!("连接浏览器失败：{e}"))?;
        Ok(Self { socket, next_id: 0 })
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let operation = async {
            self.socket
                .send(Message::Text(
                    json!({ "id": id, "method": method, "params": params })
                        .to_string()
                        .into(),
                ))
                .await
                .map_err(|e| format!("浏览器连接中断：{e}"))?;
            while let Some(message) = self.socket.next().await {
                match message.map_err(|e| format!("浏览器连接中断：{e}"))? {
                    Message::Text(text) => {
                        let response: Value =
                            serde_json::from_str(&text).map_err(|e| e.to_string())?;
                        if response["id"].as_u64() == Some(id) {
                            if let Some(error) = response.get("error") {
                                return Err(format!("浏览器操作失败：{}", error["message"]));
                            }
                            return Ok(response["result"].clone());
                        }
                    }
                    Message::Ping(payload) => {
                        self.socket
                            .send(Message::Pong(payload))
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    Message::Close(_) => return Err("查询窗口已关闭，请重新查询".into()),
                    _ => {}
                }
            }
            Err("查询窗口连接已结束，请重新查询".into())
        };
        timeout(Duration::from_secs(8), operation)
            .await
            .map_err(|_| "浏览器响应超时，请检查查询窗口后重试".to_string())?
    }
    async fn eval(&mut self, expression: &str) -> Result<Value, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        if result.get("exceptionDetails").is_some() {
            return Err("查询页面正在加载或已变化，请稍后重试".into());
        }
        Ok(result["result"]["value"].clone())
    }
}
