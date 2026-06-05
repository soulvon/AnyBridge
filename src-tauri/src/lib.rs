mod commands;

use commands::proxy::ProxyState;
use tauri::WindowEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ProxyState::default())
        .setup(|app| {
            commands::system::build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::load_config,
            commands::config::save_config,
            commands::config::load_providers,
            commands::config::save_providers,
            commands::config::set_provider_enabled,
            commands::config::test_connection,
            commands::config::fetch_models,
            commands::model_map::load_model_map,
            commands::model_map::save_model_map,
            commands::model_map::validate_model_map,
            commands::windsurf_models::list_windsurf_models,
            commands::windsurf_models::refresh_windsurf_models,
            commands::proxy::start_proxy,
            commands::proxy::stop_proxy,
            commands::proxy::get_proxy_status,
            commands::proxy::get_stats,
            commands::system::set_autostart,
            commands::system::open_config_dir,
            commands::system::generate_certs,
            commands::system::restart_windsurf,
            commands::system::detect_windsurf_path,
            commands::system::set_windsurf_path,
            commands::windsurf_config::patch_windsurf_settings,
            commands::windsurf_config::restore_windsurf_settings,
            commands::update::get_update_settings,
            commands::update::save_update_settings,
            commands::update::save_pending_update_notes,
            commands::update::check_version_jump,
 commands::update::get_app_version,
            commands::update::update_last_check_time,
            commands::update::check_for_update,
            commands::update::download_and_install_update,
        ])
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // App 退出兜底：还原 Windsurf 配置，避免残留死端口代理。
                let _ = commands::windsurf_config::restore();
                let _ = commands::workbench_inject::restore();
            }
        });
}
