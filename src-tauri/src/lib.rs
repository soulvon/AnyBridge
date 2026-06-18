#[allow(dead_code)]
mod antidebug;
mod commands;
#[allow(dead_code)]
mod integrity;

use commands::{provider_import::ProviderImportScanState, proxy::ProxyState};
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动反调试巡逻（仅 release 模式）
    #[cfg(not(debug_assertions))]
    {
        antidebug::clear_hardware_breakpoints();
        antidebug::start_patrol();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ProxyState::default())
        .manage(ProviderImportScanState::default())
        .setup(|app| {
            // 启动时先清理上一轮崩溃或异常退出后残留的孤儿 sidecar 进程，
            // 避免旧进程锁住 ide-byok-proxy.exe 导致升级安装失败。
            commands::proxy::kill_sidecar_process();

            // 运行时完整性校验（仅 release 模式）
            // 校验失败只打印警告，不退出，避免开发/测试环境误杀
            #[cfg(not(debug_assertions))]
            {
                if let Err(e) = integrity::verify_sidecar() {
                    eprintln!("[integrity] sidecar 校验警告: {}", e);
                }
                let resource_dir = app.path().resource_dir().unwrap_or_default();
                if let Err(e) = integrity::verify_resources(&resource_dir) {
                    eprintln!("[integrity] 资源校验警告: {}", e);
                }
            }

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
            commands::provider_import::scan_importable_providers,
            commands::provider_import::start_provider_import_scan,
            commands::provider_import::cancel_provider_import_scan,
            commands::provider_import::import_providers,
            commands::eval::run_provider_eval,
            commands::eval::list_eval_reports,
            commands::eval::delete_eval_report,
            commands::model_map::load_model_map,
            commands::model_map::save_model_map,
            commands::model_map::validate_model_map,
            commands::ide_models::list_ide_models,
            commands::ide_models::refresh_ide_models,
            commands::windsurf_catalog::list_windsurf_catalog,
            commands::platforms::detect_platforms,
            commands::platforms::preview_platform_switch,
            commands::platforms::switch_platform,
            commands::platforms::remove_opencode_config_from_live,
            commands::platforms::restore_platform,
            commands::platforms::restore_claude_official_config,
            commands::platforms::restore_codex_official_config,
            commands::platforms::repair_codex_session_visibility,
            commands::platforms::load_codebuddy_models,
            commands::platforms::save_codebuddy_models,
            commands::platforms::list_provider_models,
            commands::proxy::preflight_proxy,
            commands::proxy::healthcheck_grouped,
            commands::proxy::start_proxy,
            commands::proxy::stop_proxy,
            commands::proxy::get_proxy_status,
            commands::proxy::get_stats,
            commands::system::set_autostart,
            commands::system::export_proxy_logs,
            commands::system::open_config_dir,
            commands::system::generate_certs,
            commands::system::restart_ide,
            commands::system::detect_ide_path,
            commands::system::set_ide_path,
            commands::system::detect_windsurf_path,
            commands::system::set_windsurf_path,
            commands::system::is_ide_running,
            commands::system::detect_target_ide,
            commands::cert_install::cert_check_status,
            commands::cert_install::cert_install,
            commands::cert_install::cert_uninstall,
            commands::cert_install::cert_cleanup_legacy,
            commands::ide_config::patch_ide_config,
            commands::ide_config::restore_ide_config,
            commands::ide_config::patch_ide_settings,
            commands::ide_config::restore_ide_settings,
            commands::update::get_update_settings,
            commands::update::save_update_settings,
            commands::update::save_pending_update_notes,
            commands::update::check_version_jump,
            commands::update::get_app_version,
            commands::update::update_last_check_time,
            commands::update::check_for_update,
            commands::update::download_and_install_update,
            commands::update::open_download_page,
        ])
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // App 退出兆底：先杀 sidecar，再还原 IDE 配置。
                // 顺序重要——必须先杀进程再还原，否则 IDE 可能指向死端口。
                if let Some(state) = app.try_state::<ProxyState>() {
                    let child = commands::proxy::lock_or_recover(&state.child).take();
                    if let Some(c) = child {
                        let _ = c.kill();
                    }
                }
                // 双保险：按进程名全盘清理，确保不残留
                commands::proxy::kill_sidecar_process();
                // 两个 IDE 都尝试还原（幂等，无备份则空操作）
                let _ = commands::ide_config::restore("windsurf");
                let _ = commands::ide_config::restore("devin");
                let _ = commands::workbench_inject::restore("windsurf");
                let _ = commands::workbench_inject::restore("devin");
            }
        });
}
