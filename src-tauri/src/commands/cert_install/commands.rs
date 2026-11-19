use super::*;
use super::status_and_install::*;

/// 一键卸载 CA：两个 store 都尝试，幂等。
#[allow(dead_code)]
pub fn uninstall_ca() -> Result<String, String> {
    uninstall_ca_impl(None)
}

// 卸载可能修改当前 CA 信任；与安装和证书轮换共享同一跨进程独占锁。
pub(super) fn uninstall_ca_impl(app: Option<AppHandle>) -> Result<String, String> {
    let _package_lock = crate::commands::system::acquire_mitm_package_write_lock()?;
    uninstall_ca_impl_with_package_lock(app)
}

pub(super) fn uninstall_ca_impl_with_package_lock(app: Option<AppHandle>) -> Result<String, String> {
    invalidate_ca_status_cache();
    emit_cert_progress(
        app.as_ref(),
        "uninstall_start",
        "开始卸载 CA 证书",
        5,
        "warn",
    );
    let mut removed = Vec::new();

    // macOS 缺少确切指纹时停止，不把当前 CA 卸载扩大为同名证书删除。
    let current_thumbprint = if cfg!(target_os = "macos") {
        let (cert_path, _) = cert_paths()?;
        Some(compute_thumbprint(&cert_path).map_err(|e| format!(
            "无法确认待卸载 CA 指纹，未修改钥匙串；请在钥匙串访问中核对证书后手动处理: {}", e
        ))?)
    } else {
        cert_paths().ok().and_then(|(cert_path, _)| compute_thumbprint(&cert_path).ok())
    };

    // CurrentUser 卸
    emit_cert_progress(
        app.as_ref(),
        "uninstall_current_user",
        &format!("正在检查并卸载 {} 中的证书", current_user_store_label()),
        25,
        "info",
    );
    if current_thumbprint
        .as_deref()
        .map(|t| platform::is_thumbprint_in_store(t, true))
        .unwrap_or_else(|| platform::is_in_store(CA_COMMON_NAME, true))
    {
        if let Some(t) = current_thumbprint.as_deref() {
            platform::uninstall_thumbprint_from_store(t, true)?;
        } else {
            platform::uninstall_from_store(CA_COMMON_NAME, true)?;
        }
        removed.push(current_user_store_label());
    }
    // LocalMachine 卸（需要 admin，触发 UAC 弹窗）
    emit_cert_progress(
        app.as_ref(),
        "uninstall_local_machine",
        &format!("正在检查 {} 中的证书", local_machine_store_label()),
        55,
        "info",
    );
    if current_thumbprint
        .as_deref()
        .map(|t| platform::is_thumbprint_in_store(t, false))
        .unwrap_or_else(|| platform::is_in_store(CA_COMMON_NAME, false))
    {
        emit_cert_progress(
            app.as_ref(),
            "uninstall_uac",
            &format!(
                "检测到系统级证书，正在请求 {} 授权卸载",
                admin_prompt_label()
            ),
            70,
            "warn",
        );
        let uninstall_result = if let Some(t) = current_thumbprint.as_deref() {
            platform::uninstall_local_machine_thumbprint_via_uac(t)
        } else {
            platform::uninstall_from_store(CA_COMMON_NAME, false)
        };
        match uninstall_result {
            Ok(()) => removed.push(local_machine_store_label()),
            Err(e) => eprintln!("[cert_install] 卸 LocalMachine 失败: {}", e),
        }
    }

    if let Some(t) = current_thumbprint.as_deref() {
        emit_cert_progress(
            app.as_ref(),
            "uninstall_verify",
            "正在验证证书是否已从系统证书库移除",
            90,
            "info",
        );
        let still_current_user = platform::is_thumbprint_in_store(t, true);
        let still_local_machine = platform::is_thumbprint_in_store(t, false);
        if still_current_user || still_local_machine {
            emit_cert_progress(
                app.as_ref(),
                "uninstall_error",
                "证书仍残留在系统证书库中",
                100,
                "err",
            );
            return Err(format!(
                "证书仍残留在: {}{}",
                if still_current_user {
                    current_user_store_label()
                } else {
                    ""
                },
                if still_local_machine {
                    local_machine_store_label()
                } else {
                    ""
                }
            ));
        }
    }

    // 顺手卸老证书
    // macOS 卸载只针对当前确切指纹；旧根需要独立确认，不随当前 CA 卸载一起删除。
    if !cfg!(target_os = "macos") {
        let _ = cleanup_legacy_cn();
    }

    // 与 install_ca_impl 对称：按账本还原 NODE_EXTRA_CA_CERTS，保留用户改动。
    #[cfg(target_os = "windows")]
    restore_node_ca_trust()?;

    if removed.is_empty() {
        emit_cert_progress(
            app.as_ref(),
            "uninstall_done",
            "当前 CA 证书不在系统证书库，无需卸载",
            100,
            "ok",
        );
        Ok(format!(
            "CA \"{}\" 不在系统证书库，无需卸载",
            CA_COMMON_NAME
        ))
    } else {
        emit_cert_progress(
            app.as_ref(),
            "uninstall_done",
            &format!("CA 证书已从 {} 卸载", removed.join(" + ")),
            100,
            "ok",
        );
        Ok(format!("CA 已从 {} 卸载", removed.join(" + ")))
    }
}

/// 清理老版本 CN 的证书残留。
/// 升级 AnyBridge 时自动调，避免新老并存导致 certutil 行为不确定。
/// 两个 store 都查（CurrentUser + LocalMachine），因为老版本
/// 经常用 certutil -addstore Root 装到 LM。
pub fn cleanup_legacy_cn() -> Result<String, String> {
    // macOS 目前没有按确切指纹枚举并逐项确认的清理流程；拒绝按 CN 批量删除，
    // 防止误删企业管理证书、其他安装来源的根证书或用户明确保留的旧根。
    if cfg!(target_os = "macos") {
        return Err(
            "macOS 旧根清理需要用户逐项确认确切指纹；当前未执行任何钥匙串删除，请在钥匙串访问中手动核对".into(),
        );
    }

    invalidate_ca_status_cache();
    let mut msg = String::new();

    for cn in LEGACY_CA_COMMON_NAMES {
        // CurrentUser 先卸（不需要管理员）
        if platform::is_in_store(cn, true) {
            if let Ok(()) = platform::uninstall_from_store(cn, true) {
                msg.push_str(&format!("已清理老 CA \"{}\"（CurrentUser）\n", cn));
            }
        }

        // LocalMachine：仅检测/尝试非提权 delstore（无 UAC）。
        // 不能在 cleanup_legacy 里弹 UAC，否则体检修复会卡死。
        if platform::is_in_store(cn, false) {
            match platform::uninstall_from_store(cn, false) {
                Ok(()) => msg.push_str(&format!("已清理老 CA \"{}\"（LocalMachine）\n", cn)),
                Err(_) => {
                    msg.push_str(&format!(
                        "检测到老 CA \"{}\"（LocalMachine），需要管理员权限才能清理；不影响当前用户级证书\n",
                        cn
                    ));
                }
            }
        }
    }

    Ok(if msg.is_empty() {
        "无老证书残留".to_string()
    } else {
        msg
    })
}

// ──────────────────────────────────────────────────────────
// Tauri Commands（暴露给前端）
// ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn cert_check_status() -> CaStatus {
    check_ca_status()
}

/// 串行化经此入口提交的证书任务；直接调用底层函数不受此保护。
pub(super) static CERT_TASK_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

// 正常返回、错误返回及 panic 展开时都失效缓存并释放占位，不把失败前的状态留给后续轮询。
pub(super) struct CertTaskGuard {
    operation_id: String,
}

// 时间戳、进程号和进程内序号仅用于诊断关联，不承载密钥或授权凭据。
pub(super) fn next_cert_operation_id() -> String {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_nanos();
    format!("cert-{}-{stamp}-{sequence}", std::process::id())
}

impl Drop for CertTaskGuard {
    fn drop(&mut self) {
        // 守卫释放只表示底层任务结束，错误或 panic 路径也会经过这里，不代表操作成功。
        eprintln!("[cert_install][{}] task_finished", self.operation_id);
        invalidate_ca_status_cache();
        CERT_TASK_RUNNING.store(
            false,
            std::sync::atomic::Ordering::Release,
        );
    }
}

// 非阻塞获取：并发及嵌套调用直接报忙，不排队等待系统授权，避免重复弹窗或自锁。
pub(super) fn acquire_cert_task() -> Result<CertTaskGuard, String> {
    if CERT_TASK_RUNNING
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        return Err("另一个证书任务仍在执行，请等待完成后再操作".into());
    }
    let operation_id = next_cert_operation_id();
    eprintln!("[cert_install][{}] task_started", operation_id);
    Ok(CertTaskGuard { operation_id })
}

/// 为同步体检/启动路径复用同一证书互斥，避免自动修复与显式操作并发。
// 同步自动修复也绑定后端操作 ID；没有 UI 请求时 request_id 保持为空。
pub(crate) fn with_cert_task_lock<T>(
    task: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let guard = acquire_cert_task()?;
    let _operation_context = CertOperationContextGuard::set(&guard.operation_id, None);
    task().map_err(|error| format!("{} [操作 ID: {}]", error, guard.operation_id))
}

pub(crate) async fn run_cert_task(
    label: &'static str,
    app: Option<AppHandle>,
    request_id: Option<String>,
    task: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    // 外层超时不会取消已运行的阻塞任务；将守卫移入任务，实际结束后才允许下一次操作。
    let guard = acquire_cert_task()?;

    // 外层等待与阻塞任务共享同一个 ID；超时后守卫仍由阻塞任务持有。
    let operation_id = guard.operation_id.clone();

    // request ID 仅用于 UI 事件关联，限制格式和长度，避免任意调用方数据进入事件/日志。
    let request_id = request_id.filter(|id| id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    let task_operation_id = operation_id.clone();
    let task_request_id = request_id.clone();

    // 先发起始事件，让前端在任何深层进度到达前建立本次请求与后端操作的关联。
    emit_cert_progress_for_operation(app.as_ref(), "start", label, 0, "info", Some(CertOperationContext {
        operation_id: operation_id.clone(),
        request_id: request_id.clone(),
    }));

    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        // 线程本地状态不能跨 spawn_blocking 自动继承，必须在实际工作的线程重新绑定。
        let _operation_context = CertOperationContextGuard::set(&task_operation_id, task_request_id);
        task()
    });

    let result = match tokio::time::timeout(
        std::time::Duration::from_secs(CERT_TASK_TIMEOUT_SECS),
        handle,
    )
    .await
    {
        Ok(Ok(task_result)) => task_result.map_err(|error| format!("{} [操作 ID: {}]", error, operation_id)),
        Ok(Err(error)) => Err(format!("{}任务失败: {} [操作 ID: {}]", label, error, operation_id)),
        Err(_) => Err(format!(
            "{}超时（{}s）。系统授权或证书操作尚未返回；底层任务可能仍在执行，请勿重复操作，先检查系统授权界面 [操作 ID: {}]",
            label, CERT_TASK_TIMEOUT_SECS, operation_id
        )),
    };
    // 统一在包装层发最终错误事件，涵盖任务错误、JoinError 和外层超时。
    if let Err(error) = &result {
        emit_cert_progress_for_operation(
            app.as_ref(),
            "error",
            error,
            100,
            "err",
            Some(CertOperationContext { operation_id, request_id }),
        );
    }
    result
}

// 先占证书任务、再检查并占用网关启动位；检查覆盖整个安装过程，不只保护文件生成。
// request_id 只用于把前端进度事件归回发起它的 UI 调用。
#[tauri::command]
pub async fn cert_install(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    let proxy_app = app.clone();
    let progress_app = app.clone();
    run_cert_task("CA 安装", Some(app.clone()), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&proxy_app, || {
            install_ca_impl(Some(progress_app), false, false, true)
        })
    })
    .await
}

/// 停止状态下按平台策略重装；macOS 只修复现有有效包的信任，不执行强制轮换。
/// request_id 用于将本次 UI 请求与进度事件关联。
#[tauri::command]
pub async fn cert_reinstall_clean(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    let proxy_app = app.clone();
    let progress_app = app.clone();
    run_cert_task("CA 清理并重装", Some(app.clone()), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&proxy_app, || {
            install_ca_impl(Some(progress_app), true, true, true)
        })
    })
    .await
}

// 卸载也需保持网关停止，避免运行中的 TLS 链突然失去信任；失败由前端按错误展示。
// request_id 用于将本次 UI 请求与进度事件关联。
#[tauri::command]
pub async fn cert_uninstall(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    let proxy_app = app.clone();
    let progress_app = app.clone();
    run_cert_task("CA 卸载", Some(app.clone()), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&proxy_app, || {
            uninstall_ca_impl(Some(progress_app))
        })
    })
    .await
}

// 清理可能涉及系统授权，只从显式操作执行；与其他证书任务共享互斥及网关停止约束。
// request_id 用于将本次 UI 请求与进度事件关联。
#[tauri::command]
pub async fn cert_cleanup_legacy(app: AppHandle, request_id: Option<String>) -> Result<String, String> {
    let proxy_app = app.clone();
    run_cert_task("老证书清理", Some(app), request_id, move || {
        crate::commands::proxy::with_proxy_stopped(&proxy_app, cleanup_legacy_cn)
    })
    .await
}

