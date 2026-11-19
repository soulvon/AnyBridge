use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use super::*;
use super::cpa_settings_and_scan::*;
use super::github_download::*;

pub(super) fn extract_archive(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
    // 原子化解压：先解压到同级临时目录，成功后整体替换目标目录，
    // 避免解压中断在 versions/ 下留下"半成品目录"被误认为有效安装。
    let parent = target_dir
        .parent()
        .ok_or_else(|| format!("目标目录缺少父目录: {}", target_dir.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建父目录 {}: {}", parent.display(), e))?;
    let stem = target_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("component");
    let staging = parent.join(format!(".extracting-{}", stem));

    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|e| format!("无法清理临时解压目录 {}: {}", staging.display(), e))?;
    }
    fs::create_dir_all(&staging)
        .map_err(|e| format!("无法创建临时解压目录 {}: {}", staging.display(), e))?;

    if let Err(e) = extract_archive_into(archive_path, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    // 解压成功后整体替换目标目录
    if target_dir.exists() {
        fs::remove_dir_all(target_dir)
            .map_err(|e| format!("无法移除旧目录 {}: {}", target_dir.display(), e))?;
    }
    fs::rename(&staging, target_dir).map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        format!(
            "无法将临时目录 {} 重命名为 {}: {}",
            staging.display(),
            target_dir.display(),
            e
        )
    })?;
    Ok(())
}

pub(super) fn extract_archive_into(archive_path: &Path, staging_dir: &Path) -> Result<(), String> {
    let name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    if name.ends_with(".zip") {
        extract_zip_archive(archive_path, staging_dir)?;
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz_archive(archive_path, staging_dir)?;
    } else {
        return Err(format!(
            "不支持的安装包格式: {}（需要 .zip 或 .tar.gz）",
            archive_path.display()
        ));
    }

    // 解压成功后删除临时包
    let _ = fs::remove_file(archive_path);
    Ok(())
}

pub(super) fn extract_zip_archive(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    let prefix = target_dir.to_path_buf();
    let file = fs::File::open(zip_path).map_err(|e| format!("无法打开 zip 文件: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无效的 zip 文件: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {}", e))?;
        let name = entry.mangled_name();
        let entry_path = prefix.join(&name);

        if entry.is_dir() {
            fs::create_dir_all(&entry_path).map_err(|e| format!("创建目录失败: {}", e))?;
        } else {
            if let Some(parent) = entry_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
            }
            let mut outfile = fs::File::create(&entry_path)
                .map_err(|e| format!("创建文件失败 {}: {}", entry_path.display(), e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("写入文件失败 {}: {}", entry_path.display(), e))?;
        }
    }
    Ok(())
}

pub(super) fn extract_tar_gz_archive(tar_gz_path: &Path, target_dir: &Path) -> Result<(), String> {
    use flate2::read::GzDecoder;

    let file =
        fs::File::open(tar_gz_path).map_err(|e| format!("无法打开 tar.gz 文件: {}", e))?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(target_dir)
        .map_err(|e| format!("解压 tar.gz 失败: {}", e))?;

    // 确保 Unix 可执行位：对解压出的疑似二进制补 0o755
    #[cfg(unix)]
    {
        use std::io::Read;
        use std::os::unix::fs::PermissionsExt;
        fn fix_exec(dir: &Path) {
            let Ok(entries) = fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    fix_exec(&path);
                    continue;
                }
                if !path.is_file() {
                    continue;
                }
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if name.contains('.') && !name.ends_with(".sh") {
                    continue;
                }
                // 读文件头判断 ELF / Mach-O
                let mut hdr = [0u8; 4];
                if let Ok(mut f) = fs::File::open(&path) {
                    if f.read(&mut hdr).is_ok() {
                        let is_elf = &hdr == b"\x7fELF";
                        let is_macho = hdr == [0xcf, 0xfa, 0xed, 0xfe]
                            || hdr == [0xce, 0xfa, 0xed, 0xfe]
                            || hdr == [0xca, 0xfe, 0xba, 0xbe];
                        if is_elf || is_macho || name.ends_with(".sh") {
                            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
                        }
                    }
                }
            }
        }
        fix_exec(target_dir);
    }

    Ok(())
}

pub(super) fn find_exe_in_dir(dir: &Path, name_hint: &str) -> Result<PathBuf, String> {
    let hint = name_hint.to_lowercase();
    #[cfg(target_os = "windows")]
    {
        let candidate = dir.join(format!("{}.exe", name_hint));
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let candidate = dir.join(name_hint);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    fn visit(dir: &Path, hint: &str, matches: &mut Vec<PathBuf>) -> Result<(), String> {
        let entries =
            fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}: {}", dir.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取目录条目失败：{}", e))?;
            let path = entry.path();
            if path.is_dir() {
                // 跳过常见无关目录
                let dir_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if matches!(
                    dir_name.as_str(),
                    "node_modules" | ".git" | "__macosx" | "docs" | "doc"
                ) {
                    continue;
                }
                visit(&path, hint, matches)?;
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_lowercase();
            #[cfg(target_os = "windows")]
            {
                if file_name == format!("{}.exe", hint)
                    || (file_name.contains(hint) && file_name.ends_with(".exe"))
                {
                    matches.push(path);
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let looks_binary_name = file_name == hint
                    || (file_name.starts_with(hint)
                        && !file_name.contains('.')
                        && file_name
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
                let bad_suffix = [
                    ".md", ".json", ".yml", ".yaml", ".txt", ".toml", ".so", ".dylib", ".a",
                    ".o", ".h", ".c", ".go", ".rs", ".js", ".ts", ".map", ".sample", ".sha256",
                    ".sig", ".asc",
                ]
                .iter()
                .any(|s| file_name.ends_with(s));
                if looks_binary_name && !bad_suffix {
                    matches.push(path);
                }
            }
        }
        Ok(())
    }

    let mut matches = Vec::new();
    visit(dir, &hint, &mut matches)?;
    // 精确文件名优先
    matches.sort_by_key(|p| {
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();
        let exact = if cfg!(windows) {
            name == format!("{}.exe", hint)
        } else {
            name == hint
        };
        (!exact, name.len(), p.to_string_lossy().len())
    });
    matches
        .into_iter()
        .next()
        .ok_or_else(|| format!("在 {} 中未找到 {} 可执行文件", dir.display(), name_hint))
}

/// CPAMP 实际运行目录：可执行文件所在目录（发布包常再套一层平台目录）。
/// 配置、data、panelPath 都必须落在这里，否则 panelPath 不会生效。
pub(super) fn resolve_cpamp_runtime_dir(install_dir: &Path) -> Result<PathBuf, String> {
    let exe = find_exe_in_dir(install_dir, "cpa-manager-plus")?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("无法解析 CPAMP 运行目录: {}", exe.display()))
}

pub(super) fn cpamp_panel_file(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("management-auto.html")
}

pub(super) fn cpamp_env_base(secrets: &CpaSecrets, shared_data_dir: &Path) -> Vec<(String, String)> {
    vec![
        ("CPA_MANAGER_ADMIN_KEY".into(), secrets.admin_key.clone()),
        ("CPA_UPSTREAM_URL".into(), "http://127.0.0.1:8317".into()),
        ("CPA_MANAGEMENT_KEY".into(), secrets.management_key.clone()),
        // 共享数据目录：确保更新/切换版本后数据不丢失
        ("USAGE_DATA_DIR".into(), path_text(shared_data_dir)),
        ("USAGE_DB_PATH".into(), path_text(&shared_data_dir.join("usage.sqlite"))),
        ("CPA_MANAGER_DATA_KEY_PATH".into(), path_text(&shared_data_dir.join("data.key"))),
    ]
}

pub(super) fn cpamp_env_with_panel(secrets: &CpaSecrets, runtime_dir: &Path, shared_data_dir: &Path) -> Vec<(String, String)> {
    let mut env = cpamp_env_base(secrets, shared_data_dir);
    let panel = cpamp_panel_file(runtime_dir);
    // 绝对路径更稳：覆盖内嵌 /management.html，不会新增 /management-auto.html 路由
    env.push(("PANEL_PATH".into(), path_text(&panel)));
    env
}

/// 同步 CPAMP 数据库中的管理员密钥与 secrets.json。
/// CPAMP 首次启动后会把管理员密钥持久化到 SQLite，后续启动不再读取
/// CPA_MANAGER_ADMIN_KEY 环境变量。因此每次启动前需要用 reset-admin-key
/// 强制同步，避免 AnyBridge 面板显示的密钥与实际有效密钥不一致。
pub(super) fn reset_cpamp_admin_key(exe_path: &Path, runtime_dir: &Path, admin_key: &str) -> Result<(), String> {
    // 优先使用共享数据目录，兼容旧版本的 runtime_dir/data
    let root = current_cpa_install_root();
    let shared_db = root.join("cpamp-data").join("usage.sqlite");
    let legacy_db = runtime_dir.join("data").join("usage.sqlite");
    let db_path = if shared_db.is_file() {
        shared_db
    } else if legacy_db.is_file() {
        legacy_db
    } else {
        // 数据库尚不存在，依赖 CPA_MANAGER_ADMIN_KEY 环境变量首次初始化
        return Ok(());
    };

    let mut cmd = std::process::Command::new(exe_path);
    cmd.current_dir(runtime_dir)
        .env("CPA_MANAGER_ADMIN_KEY", admin_key)
        .args([
            "reset-admin-key",
            "--admin-key",
            admin_key,
            "--db-path",
            &path_text(&db_path),
        ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .output()
        .map_err(|e| format!("执行 reset-admin-key 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "同步 CPAMP 管理员密钥失败（{}）。stderr: {} stdout: {}",
            output.status, stderr, stdout
        ));
    }
    Ok(())
}

/// 执行 CPAMP 数据库离线派生维护（创建新版本延迟索引、清理旧派生数据）。
/// CPAMP v1.12.0+ 采用 Listener-First 机制，新版本启动时不会自动为大数据库执行索引创建和清理，
/// 必须在离线状态下通过 cleanup-derived 完成，否则面板会提示「数据库升级维护尚未完成」并降低性能。
pub(super) fn cleanup_cpamp_derived(exe_path: &Path, runtime_dir: &Path) -> Result<(), String> {
    let root = current_cpa_install_root();
    let shared_db = root.join("cpamp-data").join("usage.sqlite");
    let legacy_db = runtime_dir.join("data").join("usage.sqlite");
    let db_path = if shared_db.is_file() {
        shared_db
    } else if legacy_db.is_file() {
        legacy_db
    } else {
        return Ok(());
    };

    let mut cmd = std::process::Command::new(exe_path);
    cmd.current_dir(runtime_dir)
        .args([
            "cleanup-derived",
            "--db-path",
            &path_text(&db_path),
        ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .output()
        .map_err(|e| format!("执行 CPAMP cleanup-derived 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "执行 CPAMP 数据库派生维护失败（{}）。stderr: {} stdout: {}",
            output.status, stderr, stdout
        ));
    }
    Ok(())
}

pub(super) fn start_service(
    exe_path: &Path,
    working_dir: &Path,
    env_vars: &[(String, String)],
) -> Result<u32, String> {
    let mut cmd = std::process::Command::new(exe_path);
    cmd.current_dir(working_dir);
    for (key, val) in env_vars {
        cmd.env(key, val);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {}", exe_path.display(), e))?;
    Ok(child.id())
}

pub(super) async fn wait_for_http(port: u16, path: &str, label: &str, max_retries: u32) -> Result<(), String> {
    wait_for_http_with_key(port, path, label, max_retries, None).await
}

pub(super) async fn wait_for_http_with_key(port: u16, path: &str, label: &str, max_retries: u32, mgmt_key: Option<String>) -> Result<(), String> {
    let mut total_waited: u64 = 0;
    for attempt in 0..max_retries {
        // 首次不等待，后续指数退避：1s→2s→4s→8s→cap 10s
        if attempt > 0 {
            let delay_secs = std::cmp::min(10u64, 1u64 << (attempt - 1));
            tokio::time::sleep(Duration::from_secs(delay_secs)).await;
            total_waited += delay_secs;
        }
        let probe = {
            let path = path.to_string();
            let label = label.to_string();
            let key = mgmt_key.clone();
            tauri::async_runtime::spawn_blocking(move || probe_http_port_with_key(port, &path, &label, key.as_deref()))
                .await
                .map_err(|e| e.to_string())?
        };
        if probe.status == "running" {
            return Ok(());
        }
    }
    Err(format!(
        "{} (端口 {}) 健康检查超时，已等待约 {} 秒",
        label,
        port,
        total_waited
    ))
}

pub(super) fn write_cpa_config(
    dir: &Path,
    mgmt_key: &str,
    api_key: &str,
    old_config: Option<&Path>,
) -> Result<(), String> {
    let settings = read_cpa_settings();
    let proxy_url = resolve_cpa_proxy_url(&settings).unwrap_or_default();
    let proxy_escaped = yaml_escape_double_quoted(&proxy_url);
    let mut content = format!(
        "host: \"127.0.0.1\"\n\
         port: 8317\n\
         tls:\n\
         \x20 enable: false\n\
         \x20 cert: \"\"\n\
         \x20 key: \"\"\n\
         remote-management:\n\
         \x20 allow-remote: false\n\
         \x20 secret-key: \"{}\"\n\
         \x20 disable-control-panel: false\n\
         auth-dir: \"auth\"\n\
         api-keys:\n\
         \x20 - \"{}\"\n\
         debug: false\n\
         usage-statistics-enabled: true\n\
         redis-usage-queue-retention-seconds: 300\n\
         request-retry: 1\n\
         proxy-url: \"{}\"\n\
         quota-exceeded:\n\
         \x20 switch-project: true\n\
         \x20 switch-preview-model: true\n\
         \x20 antigravity-credits: true\n\
         routing:\n\
         \x20 strategy: \"round-robin\"\n\
         \x20 session-affinity: false\n\
         \x20 session-affinity-ttl: \"1h\"\n\
         ws-auth: true\n",
        mgmt_key, api_key, proxy_escaped
    );
    // plugins 段（含各插件的启用状态与配置）只持久化在 config.yaml 中，
    // auth/ 与 plugins/ 目录虽已随版本迁移，若此处被模板重写抹掉，
    // 升级/切换版本后插件会静默变为未启用。优先保留旧版本配置，解析失败时回落默认值。
    let plugins_section = old_config
        .and_then(extract_plugins_section)
        .unwrap_or_else(default_plugins_section);
    let mut wrap = serde_yaml::Mapping::new();
    wrap.insert(
        serde_yaml::Value::String("plugins".to_string()),
        plugins_section,
    );
    if let Ok(yaml) = serde_yaml::to_string(&serde_yaml::Value::Mapping(wrap)) {
        content.push_str(&yaml);
    }
    let target = dir.join("config.yaml");
    fs::write(&target, content).map_err(|e| format!("写入 CPA config.yaml 失败: {}", e))
}

/// 从旧版本 config.yaml 提取 plugins 段；文件不存在、解析失败或字段缺失时返回 None。
pub(super) fn extract_plugins_section(old_config: &Path) -> Option<serde_yaml::Value> {
    let content = fs::read_to_string(old_config).ok()?;
    let doc: serde_yaml::Value = serde_yaml::from_str(&content).ok()?;
    let mapping = doc.as_mapping()?;
    let (_, plugins) = mapping
        .iter()
        .find(|(k, _)| k.as_str() == Some("plugins"))?;
    if plugins.is_mapping() {
        Some(plugins.clone())
    } else {
        None
    }
}

/// 全新安装时的默认 plugins 段（与历史模板一致）。
pub(super) fn default_plugins_section() -> serde_yaml::Value {
    let mut m = serde_yaml::Mapping::new();
    m.insert(
        serde_yaml::Value::String("enabled".to_string()),
        serde_yaml::Value::Bool(true),
    );
    m.insert(
        serde_yaml::Value::String("dir".to_string()),
        serde_yaml::Value::String("plugins".to_string()),
    );
    serde_yaml::Value::Mapping(m)
}

pub(super) fn write_cpamp_config(dir: &Path, data_dir: &Path) -> Result<(), String> {
    // dataDir 使用绝对路径，指向 CPA suite 根目录下的共享数据目录，
    // 这样更新/切换版本时数据（usage.sqlite、data.key、凭据、历史等）不会丢失。
    // panelPath 相对路径相对于 CPAMP 运行目录（exe 同目录）
    fs::create_dir_all(data_dir).map_err(|e| format!("创建 CPAMP 数据目录失败: {}", e))?;
    let json = serde_json::json!({
        "httpAddr": "127.0.0.1:18317",
        "dataDir": path_text(data_dir),
        "cpaUpstreamUrl": "http://127.0.0.1:8317",
        "panelPath": "management-auto.html"
    });
    let json_str =
        serde_json::to_string_pretty(&json).map_err(|e| format!("序列化 CPAMP 配置失败: {}", e))?;
    let target = dir.join("config.json");
    fs::write(&target, &json_str).map_err(|e| format!("写入 CPAMP config.json 失败: {}", e))
}

/// 将旧版本 runtime 目录下的 data/ 迁移到共享数据目录（仅首次迁移）
pub(super) fn migrate_cpamp_data(runtime_dir: &Path, shared_data_dir: &Path) -> Result<(), String> {
    if shared_data_dir.join("usage.sqlite").is_file() {
        return Ok(()); // 共享目录已有数据，无需迁移
    }
    let old_data = runtime_dir.join("data");
    if !old_data.is_dir() {
        return Ok(()); // 旧版本也没有数据，无需迁移
    }
    fs::create_dir_all(shared_data_dir)
        .map_err(|e| format!("创建共享数据目录失败: {}", e))?;
    for entry in fs::read_dir(&old_data).map_err(|e| format!("读取旧 data 目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let src = entry.path();
        let dst = shared_data_dir.join(entry.file_name());
        if src.is_file() {
            fs::copy(&src, &dst)
                .map_err(|e| format!("迁移数据文件失败 {}: {}", src.display(), e))?;
        }
    }
    Ok(())
}

/// 获取 CPAMP 管理面板 HTML 并注入自动登录脚本。
/// 写入 runtime_dir/management-auto.html，并通过 PANEL_PATH 覆盖 /management.html。
pub(super) fn patch_cpamp_management_html(runtime_dir: &Path, admin_key: &str) -> Result<(), String> {
    let patched_path = cpamp_panel_file(runtime_dir);

    // 先删除旧补丁文件，确保能获取到内嵌原版（若 PANEL_PATH 尚未生效）
    let _ = fs::remove_file(&patched_path);

    // 从 CPAMP 获取内嵌的 management.html（带重试，等待 CPAMP HTTP 就绪）
    let url = format!("http://127.0.0.1:{}/management.html", CPAMP_PORT);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let html = {
        let mut last_err = String::new();
        let mut result: Option<String> = None;
        for _ in 0..10 {
            match client.get(&url).send() {
                Ok(resp) => match resp.text() {
                    Ok(text) if !text.is_empty() => {
                        // 若已是补丁页（极少见：上一轮 PANEL_PATH 仍在），不要重复注入
                        if text.contains("ANYBRIDGE_AUTO_LOGIN") {
                            result = Some(text);
                            break;
                        }
                        result = Some(text);
                        break;
                    }
                    Ok(_) => {
                        last_err = "management.html 响应为空".to_string();
                    }
                    Err(e) => last_err = e.to_string(),
                },
                Err(e) => last_err = e.to_string(),
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        match result {
            Some(text) => text,
            None => {
                return Err(format!(
                    "获取 management.html 失败（重试 10 次仍无法连接）: {}",
                    last_err
                ))
            }
        }
    };

    // 已有补丁则直接落盘，保证 runtime 目录有文件供 PANEL_PATH 使用
    if html.contains("ANYBRIDGE_AUTO_LOGIN") {
        fs::write(&patched_path, html.as_bytes())
            .map_err(|e| format!("写入 management-auto.html 失败: {}", e))?;
        return Ok(());
    }

    // 构建自动登录脚本
    let escaped_key = admin_key
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");

    let inject_script = format!(
        r#"<script>/* ANYBRIDGE_AUTO_LOGIN */(function(){{var K="{}";var B="http://127.0.0.1:{}";try{{if(localStorage.getItem("isLoggedIn")==="true"){{var e=localStorage.getItem("cli-proxy-auth");if(e&&e.indexOf(K)!==-1)return;}}}}catch(e){{}}localStorage.setItem("isLoggedIn","true");localStorage.setItem("apiBase",JSON.stringify(B));localStorage.setItem("managementKey",JSON.stringify(K));localStorage.setItem("cli-proxy-auth",JSON.stringify({{"state":{{"apiBase":B,"managementKey":K,"rememberPassword":true,"serverVersion":null,"serverBuildDate":null,"supportsPlugin":false,"sessionMode":"manager_embedded","sessionPanelBase":B,"connectionStatus":"disconnected","connectionError":null}},"version":0}}));}})();</script>"#,
        escaped_key, CPAMP_PORT
    );

    // 在 <head> 后注入脚本
    let patched_html = if html.contains("<head>") {
        html.replacen("<head>", &format!("<head>{}", inject_script), 1)
    } else if html.contains("<html") {
        if let Some(pos) = html.find("<html") {
            if let Some(end) = html[pos..].find('>') {
                let insert_pos = pos + end + 1;
                format!("{}{}{}", &html[..insert_pos], inject_script, &html[insert_pos..])
            } else {
                format!("{}{}", inject_script, html)
            }
        } else {
            format!("{}{}", inject_script, html)
        }
    } else {
        format!("{}{}", inject_script, html)
    };

    fs::write(&patched_path, patched_html.as_bytes())
        .map_err(|e| format!("写入 management-auto.html 失败: {}", e))
}

