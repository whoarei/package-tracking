pub mod browser;
pub mod engine;
pub mod model;
pub mod storage;

#[cfg(feature = "desktop")]
mod desktop {
    use super::{browser::BrowserSource, engine::Engine, model::*};
    use std::sync::Arc;
    use tauri::{Emitter, Manager, State};

    #[tauri::command]
    async fn get_snapshot(engine: State<'_, Arc<Engine>>) -> Result<Snapshot, String> {
        Ok(engine.snapshot().await)
    }
    #[tauri::command]
    async fn import_shipments(
        engine: State<'_, Arc<Engine>>,
        rows: Vec<ImportRow>,
    ) -> Result<ImportResult, String> {
        engine.import(rows).await
    }
    #[tauri::command]
    async fn update_shipment(
        engine: State<'_, Arc<Engine>>,
        id: String,
        note: String,
        tracking: bool,
        carrier: String,
    ) -> Result<(), String> {
        engine.update(id, note, tracking, carrier).await
    }
    #[tauri::command]
    async fn remove_shipments(
        engine: State<'_, Arc<Engine>>,
        ids: Vec<String>,
    ) -> Result<(), String> {
        engine.remove(ids).await
    }
    #[tauri::command]
    async fn save_settings(
        engine: State<'_, Arc<Engine>>,
        settings: Settings,
    ) -> Result<(), String> {
        engine.settings(settings).await
    }
    #[tauri::command]
    async fn start_query(engine: State<'_, Arc<Engine>>, ids: Vec<String>) -> Result<(), String> {
        engine.inner().start(ids).await
    }
    #[tauri::command]
    async fn control_job(engine: State<'_, Arc<Engine>>, action: String) -> Result<(), String> {
        engine.control(&action).await
    }
    #[tauri::command]
    async fn open_browser(engine: State<'_, Arc<Engine>>) -> Result<(), String> {
        engine.open_browser().await
    }
    #[tauri::command]
    async fn export_csv(path: String, contents: String) -> Result<(), String> {
        let path = std::path::PathBuf::from(path);
        if !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("csv"))
        {
            return Err("请选择 .csv 文件路径".into());
        }
        if contents.len() > 20 * 1024 * 1024 {
            return Err("导出文件超过 20 MB，请减少运单数量".into());
        }
        std::fs::write(&path, contents).map_err(|e| format!("导出失败：{e}"))
    }

    pub fn run() {
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_dialog::init())
            .setup(|app| {
                let dir = app.path().app_local_data_dir()?;
                let source = Arc::new(BrowserSource::new(&dir));
                let handle = app.handle().clone();
                let engine = Engine::new(
                    dir,
                    source,
                    Arc::new(move |snapshot| {
                        let _ = handle.emit("desk:changed", snapshot);
                    }),
                )
                .map_err(std::io::Error::other)?;
                // Use Tauri's runtime rather than assuming setup is already in a Tokio context.
                let background = engine.clone();
                tauri::async_runtime::spawn(async move {
                    background.spawn_scheduler();
                });
                app.manage(engine);
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                get_snapshot,
                import_shipments,
                update_shipment,
                remove_shipments,
                save_settings,
                start_query,
                control_job,
                open_browser,
                export_csv
            ])
            .build(tauri::generate_context!())
            .expect("运单工作台启动失败，请检查本地数据目录及 WebView2 安装")
            .run(|app, event| {
                if let tauri::RunEvent::Exit = event {
                    if let Some(engine) = app.try_state::<Arc<Engine>>() {
                        tauri::async_runtime::block_on(engine.shutdown());
                    }
                }
            });
    }
}

#[cfg(feature = "desktop")]
pub use desktop::run;
