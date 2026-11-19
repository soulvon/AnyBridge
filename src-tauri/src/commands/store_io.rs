//! 统一配置存储的原子写与跨进程文件锁事务底座（SSOT IO）。
//!
//! 锁序纪律（彻底消除同进程 `flock`/`LockFileEx` 语义差异与死锁）：
//! 1. 进程内规范化路径 `Mutex`（`OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>>`）；
//! 2. 同目录 `.lock` 侧车文件上的跨进程系统锁（标准库 `std::fs::File::lock()`）。
//!
//! 契约：
//! - `write_atomic` / `write_atomic_private` 为**无锁底层原语**，通过 PID + 纳秒时间戳 + 原子自增序数
//!   构造唯一临时文件并重试 rename，确保单次写盘不碰撞、不损坏、不断软链接。
//! - 所有 Read-Modify-Write 事务必须通过 `with_file_lock` / `update_provider_store` / `update_proxy_routes`
//!   在持有同一把锁的临界区内完成；严禁在持锁闭包内再次对同一路径加锁，亦严禁在持锁期间做网络请求。

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::config::{config_dir_path, normalize_provider_api_keys, providers_path, CodexConfig, ProviderStore};
use super::proxy_routes::{
    codex_proxy_routes_path, default_version, normalize_routes, proxy_routes_path, read_routes_from_unlocked,
    validate_routes, write_routes_to_unlocked, ProxyRoutes,
};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
static FILE_MUTEXES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

struct FileUnlockGuard(fs::File);

impl Drop for FileUnlockGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// 符号链接解析：目标是符号链接（含多级）时返回最终指向的文件路径，
/// 否则原样返回。解析中断/悬空链接时返回原路径。
pub(crate) fn resolve_symlink_target(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    for _ in 0..16 {
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.is_symlink() => {
                let link = match fs::read_link(&current) {
                    Ok(l) => l,
                    Err(_) => return path.to_path_buf(),
                };
                let next = if link.is_absolute() {
                    link
                } else {
                    match current.parent() {
                        Some(parent) => parent.join(link),
                        None => return path.to_path_buf(),
                    }
                };
                current = next;
            }
            _ => return current,
        }
    }
    path.to_path_buf()
}

/// 构造同目录唯一临时路径：`{prefix}{name}.{pid}.{nanos}.{seq}{suffix}`。
pub(crate) fn unique_tmp_path(target: &Path, prefix: &str, suffix: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    target.with_file_name(format!(
        "{prefix}{name}.{}.{unique}.{seq}{suffix}",
        std::process::id()
    ))
}

/// 无锁底层原子写：解析软链 → 写同目录唯一临时文件 → 最多 3 次重试 rename 替换目标。
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let target = resolve_symlink_target(path);
    let tmp = unique_tmp_path(&target, "", ".byok-tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let mut last_err = String::new();
    for i in 0..3u32 {
        match fs::rename(&tmp, &target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                if i < 2 {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(last_err)
}

/// 独占创建私有临时文件（拒绝已有文件/符号链接，Unix 直接 0o600 落盘并 sync_all）。
pub(crate) fn write_private_cert_temp(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let write_result = file.write_all(contents).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        return match fs::remove_file(path) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(std::io::Error::new(
                error.kind(),
                format!("{}；清理临时证书文件失败: {}", error, cleanup_error),
            )),
        };
    }
    Ok(())
}

#[cfg(any(unix, test))]
pub(crate) fn commit_unix_cert_file(tmp: &Path, path: &Path) -> Result<(), String> {
    fs::rename(tmp, path).map_err(|error| {
        format!(
            "原子写入证书失败 {} ({})；未删除原目标，临时文件保留于 {}",
            path.to_string_lossy(),
            error,
            tmp.to_string_lossy()
        )
    })
}

/// 私有文件（证书/私钥）原子写：统一 PID + 纳秒 + 原子自增序数临时名 + 0o600 落盘。
pub(crate) fn write_atomic_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("证书路径缺少父目录: {}", path.to_string_lossy()))?;
    fs::create_dir_all(parent).map_err(|e| {
        format!(
            "无法创建目录 {} ({})。请检查写权限/杀软拦截",
            parent.to_string_lossy(),
            e
        )
    })?;

    let tmp = unique_tmp_path(path, ".", ".tmp");
    write_private_cert_temp(&tmp, bytes).map_err(|e| {
        format!(
            "写入临时文件失败 {} ({})。请检查磁盘空间、写权限或同名残留；不会覆盖已有临时文件",
            tmp.to_string_lossy(),
            e
        )
    })?;

    #[cfg(unix)]
    return commit_unix_cert_file(&tmp, path);

    #[cfg(not(unix))]
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            if path.exists() {
                let _ = fs::remove_file(path);
            }
            match fs::rename(&tmp, path) {
                Ok(()) => Ok(()),
                Err(e2) => {
                    let copy_result = fs::copy(&tmp, path);
                    let _ = fs::remove_file(&tmp);
                    match copy_result {
                        Ok(_) => Ok(()),
                        Err(e3) => Err(format!(
                            "原子写入证书失败 {} (rename: {}; retry: {}; copy: {})",
                            path.to_string_lossy(),
                            rename_err,
                            e2,
                            e3
                        )),
                    }
                }
            }
        }
    }
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn canonical_lock_path(path: &Path) -> PathBuf {
    let resolved = resolve_symlink_target(path);
    if let Ok(canon) = fs::canonicalize(&resolved) {
        return canon;
    }
    let abs = normalize_lexical(&resolved);
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = abs.as_path();
    while let Some(parent) = cur.parent() {
        if let Some(name) = cur.file_name() {
            tail.push(name.to_os_string());
        }
        if parent.exists() {
            if let Ok(mut base) = fs::canonicalize(parent) {
                for seg in tail.into_iter().rev() {
                    base.push(seg);
                }
                return base;
            }
            break;
        }
        cur = parent;
    }
    abs
}

fn lock_key_for(canonical_target: &Path) -> String {
    let raw = canonical_target.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        raw.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        raw
    }
}

fn process_mutex_for(canonical_target: &Path) -> Arc<Mutex<()>> {
    let key = lock_key_for(canonical_target);
    let map = FILE_MUTEXES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn sidecar_lock_path(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_os_string();
    s.push(".lock");
    PathBuf::from(s)
}

/// 在「进程内规范化路径 Mutex + 同目录 `.lock` 跨进程锁」保护下执行事务闭包。
pub(crate) fn with_file_lock<T>(
    path: &Path,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let canonical = canonical_lock_path(path);
    let proc_mutex = process_mutex_for(&canonical);
    let _proc_guard = proc_mutex.lock().unwrap_or_else(|e| e.into_inner());

    let lock_path = sidecar_lock_path(&canonical);
    if let Some(parent) = lock_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建锁目录 {} 失败: {e}", parent.display()))?;
        }
    }
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| format!("打开锁文件 {} 失败: {e}", lock_path.display()))?;
    lock_file
        .lock()
        .map_err(|e| format!("获取跨进程文件锁 {} 失败: {e}", lock_path.display()))?;
    let _file_guard = FileUnlockGuard(lock_file);

    f()
}

/// 非阻塞通知 Sidecar 重载模型池，避免写盘路径阻塞调用线程 2 秒。
pub(crate) fn notify_sidecar_invalidate_models_async() {
    #[cfg(not(test))]
    {
        let _ = std::thread::Builder::new()
            .name("byok-invalidate-models".to_string())
            .spawn(|| {
                let port = super::config::configured_proxy_ports().api_port;
                let _ = super::codex_desktop::http_post_local(
                    port,
                    "/__byok/invalidate-models",
                    "{}",
                    Duration::from_secs(2),
                );
            });
    }
}

fn read_provider_store_unlocked(path: &Path) -> Result<ProviderStore, String> {
    if !path.exists() {
        return Ok(ProviderStore::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut store: ProviderStore =
        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;

    if let Some(raw_providers) = value.get("providers").and_then(|v| v.as_array()) {
        let mut migrated_ids = std::collections::BTreeSet::new();
        let mut migrated_configs = Vec::new();
        for raw_provider in raw_providers {
            let id = raw_provider
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let meta_codex = raw_provider
                .get("meta")
                .and_then(|m| m.get("codexConfig"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let generated_codex_id = id
                .strip_prefix("codex-")
                .and_then(|rest| rest.chars().next())
                .map(|ch| ch.is_ascii_digit())
                .unwrap_or(false);
            if !meta_codex && !generated_codex_id {
                continue;
            }

            let mut config: CodexConfig =
                serde_json::from_value(raw_provider.clone()).map_err(|e| e.to_string())?;
            if config.source_provider_id.is_empty() {
                config.source_provider_id = raw_provider
                    .get("meta")
                    .and_then(|m| m.get("sourceProviderId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
            }
            migrated_ids.insert(id.to_string());
            migrated_configs.push(config);
        }

        if !migrated_ids.is_empty() {
            store.providers.retain(|p| !migrated_ids.contains(&p.id));
            for config in migrated_configs {
                if !store.codex_configs.iter().any(|c| c.id == config.id) {
                    store.codex_configs.push(config);
                }
            }
        }
    }

    Ok(store)
}

fn write_provider_store_unlocked(path: &Path, store: &ProviderStore) -> Result<(), String> {
    let mut normalized = store.clone();
    normalize_provider_api_keys(&mut normalized);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let json = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    write_atomic(path, json.as_bytes())
}

pub(crate) fn read_provider_store_at(path: &Path) -> Result<ProviderStore, String> {
    with_file_lock(path, || read_provider_store_unlocked(path))
}

/// 对指定路径的 `ProviderStore` 执行受锁保护的 Read-Modify-Write 事务。
/// 闭包返回 `(changed, output)`；仅当 `changed == true` 时落盘。
pub(crate) fn update_provider_store_at<T>(
    path: &Path,
    f: impl FnOnce(&mut ProviderStore) -> Result<(bool, T), String>,
) -> Result<(bool, T), String> {
    with_file_lock(path, || {
        let mut store = read_provider_store_unlocked(path)?;
        let (changed, result) = f(&mut store)?;
        if changed {
            write_provider_store_unlocked(path, &store)?;
        }
        Ok((changed, result))
    })
}

/// 对全局 `providers.json` 执行受锁保护的 Read-Modify-Write 事务；
/// 仅当 `changed == true` 时落盘，并在锁外异步通知 Sidecar 重载。
pub(crate) fn update_provider_store<T>(
    f: impl FnOnce(&mut ProviderStore) -> Result<(bool, T), String>,
) -> Result<T, String> {
    let path = providers_path();
    let (changed, result) = update_provider_store_at(&path, f)?;
    if changed {
        notify_sidecar_invalidate_models_async();
    }
    Ok(result)
}

/// 对指定路径的 `ProxyRoutes` 执行受锁保护的 Read-Modify-Write 事务。
pub(crate) fn update_proxy_routes_at<T>(
    path: &Path,
    f: impl FnOnce(&mut ProxyRoutes) -> Result<(bool, T), String>,
) -> Result<T, String> {
    with_file_lock(path, || {
        let mut routes = read_routes_from_unlocked(path)?;
        let (changed, result) = f(&mut routes)?;
        if changed {
            if routes.version == 0 {
                routes.version = default_version();
            }
            normalize_routes(&mut routes);
            validate_routes(&routes)?;
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
            }
            write_routes_to_unlocked(path, &routes)?;
        }
        Ok(result)
    })
}

pub(crate) fn update_proxy_routes<T>(
    f: impl FnOnce(&mut ProxyRoutes) -> Result<(bool, T), String>,
) -> Result<T, String> {
    let path = proxy_routes_path();
    let _ensure_dir = config_dir_path();
    update_proxy_routes_at(&path, f)
}

pub(crate) fn update_codex_proxy_routes<T>(
    f: impl FnOnce(&mut ProxyRoutes) -> Result<(bool, T), String>,
) -> Result<T, String> {
    let path = codex_proxy_routes_path();
    let _ensure_dir = config_dir_path();
    update_proxy_routes_at(&path, f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use super::super::config::Provider;
    use super::super::proxy_routes::{ProxyRoute, ProxyRouteCapabilities, ProxyRouteEnhancement, ProxyRouteTarget};

    fn test_tmp_dir(tag: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "anybridge-store-io-{tag}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn minimal_provider(id: &str) -> Provider {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "apiHost": "https://example.com",
            "apiKey": format!("sk-{id}"),
            "defaultModel": "gpt-5"
        }))
        .unwrap()
    }

    #[test]
    fn concurrent_update_provider_store_preserves_all_updates() {
        let dir = test_tmp_dir("concurrent-providers");
        let path = dir.join("providers.json");
        let threads = 8usize;
        let per_thread = 10usize;
        let mut handles = Vec::new();
        for t in 0..threads {
            let p = path.clone();
            handles.push(std::thread::spawn(move || {
                for j in 0..per_thread {
                    let id = format!("prov-{t}-{j}");
                    update_provider_store_at(&p, |store| {
                        store.providers.push(minimal_provider(&id));
                        Ok((true, ()))
                    })
                    .unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let final_store = read_provider_store_at(&path).unwrap();
        assert_eq!(
            final_store.providers.len(),
            threads * per_thread,
            "并发 RMW 不得丢失任何更新"
        );
        let ids: HashSet<_> = final_store.providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), threads * per_thread);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_update_proxy_routes_preserves_all_updates() {
        let dir = test_tmp_dir("concurrent-routes");
        let path = dir.join("proxy-routes.json");
        let threads = 8usize;
        let per_thread = 10usize;
        let mut handles = Vec::new();
        for t in 0..threads {
            let p = path.clone();
            handles.push(std::thread::spawn(move || {
                for j in 0..per_thread {
                    let route_id = format!("model-{t}-{j}");
                    update_proxy_routes_at(&p, |routes| {
                        routes.routes.push(ProxyRoute {
                            uid: String::new(),
                            id: route_id.clone(),
                            display_name: route_id.clone(),
                            id_from_rename_rule: false,
                            enabled: true,
                            exposed_formats: vec!["openai".into()],
                            source: "test".into(),
                            capabilities: ProxyRouteCapabilities::default(),
                            enhancement: ProxyRouteEnhancement::default(),
                            targets: vec![ProxyRouteTarget {
                                provider_id: "p1".into(),
                                model: route_id.clone(),
                                api_format: "openai".into(),
                                ..Default::default()
                            }],
                        });
                        Ok((true, ()))
                    })
                    .unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let raw = fs::read_to_string(&path).unwrap();
        let final_routes: ProxyRoutes = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            final_routes.routes.len(),
            threads * per_thread,
            "并发路由 RMW 不得丢失任何条目"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_mixed_canonical_paths_share_lock_and_preserve_updates() {
        let dir = test_tmp_dir("concurrent-canonical");
        let sub = dir.join("nested");
        fs::create_dir_all(&sub).unwrap();
        let canonical = dir.join("providers.json");
        let alias = sub.join("..").join("providers.json");
        let threads = 8usize;
        let per_thread = 8usize;
        let mut handles = Vec::new();
        for t in 0..threads {
            let p = if t % 2 == 0 {
                canonical.clone()
            } else {
                alias.clone()
            };
            handles.push(std::thread::spawn(move || {
                for j in 0..per_thread {
                    let id = format!("mix-{t}-{j}");
                    update_provider_store_at(&p, |store| {
                        store.providers.push(minimal_provider(&id));
                        Ok((true, ()))
                    })
                    .unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let final_store = read_provider_store_at(&canonical).unwrap();
        assert_eq!(final_store.providers.len(), threads * per_thread);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_provider_store_at_error_and_noop_do_not_corrupt_or_poison_lock() {
        let dir = test_tmp_dir("rmw-error-noop");
        let path = dir.join("providers.json");
        update_provider_store_at(&path, |store| {
            store.providers.push(minimal_provider("initial"));
            Ok((true, ()))
        })
        .unwrap();
        let before = fs::read_to_string(&path).unwrap();

        let err = update_provider_store_at(&path, |store| {
            store.providers.push(minimal_provider("aborted"));
            Err::<(bool, ()), _>("simulated failure".to_string())
        });
        assert!(err.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);

        let (changed, ()) = update_provider_store_at(&path, |_| Ok((false, ()))).unwrap();
        assert!(!changed);

        update_provider_store_at(&path, |store| {
            store.providers.push(minimal_provider("after-error"));
            Ok((true, ()))
        })
        .unwrap();
        let store = read_provider_store_at(&path).unwrap();
        let ids: Vec<_> = store.providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["initial", "after-error"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
