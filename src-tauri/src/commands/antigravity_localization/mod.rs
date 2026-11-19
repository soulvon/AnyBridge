// antigravity_localization.rs — Antigravity 独立桌面端与 IDE 双端深度汉化及热更新管理器
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const CURRENT_EMBEDDED_VERSION: &str = "2.18.1";
const UPSTREAM_RAW_URL: &str =
    "https://raw.githubusercontent.com/liominsb/Antigravity-Chinese-Localization/master/localize.js";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLocalizationStatus {
    pub target: String,
    pub installed: bool,
    pub localized: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub release_name: Option<String>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalizationOperationResult {
    pub ok: bool,
    pub message: String,
    pub localized: bool,
}

/// asar payload 的真实起点：`8 + 头部声明的 header 总长（bytes[4..8]）`。
///
/// asar 头部是 Chromium pickle 格式：`[4][headerBufLen][4][jsonLen][json][padding]`，
/// Electron 以 `8 + bytes[4..8]` 为 payload 基准（headerBufLen 已含 padding）。
/// 若直接用 `16 + jsonLen` 会把 pickle 的 0..3 字节对齐填充算进 payload，
/// 导致所有文件读取偏移、注入内容混入上一个文件的尾部碎片而语法非法。
/// 注意写回时 `[4..8]`/`[8..12]` 字段必须同步加上 padding（见 asar_padding_len），
/// 否则会出现"声明基准"与"实际布局"错位、客户端启动即崩。
pub(crate) fn asar_payload_start(declared_header_size: usize) -> usize {
    8 + declared_header_size
}

/// header JSON 之后需要补的 pickle 对齐填充字节数（0..3）。
/// 写回时必须同时把 padding 加进 `[4..8]` 与 `[8..12]` 字段。
pub(crate) fn asar_padding_len(json_len: usize) -> usize {
    let raw = 16 + json_len;
    ((raw + 3) & !3) - raw
}

pub(super) fn cache_dir() -> PathBuf {
    if let Some(dir) = dirs::data_dir() {
        let p = dir
            .join("AnyBridge")
            .join("localization")
            .join("antigravity");
        let _ = fs::create_dir_all(&p);
        p
    } else {
        PathBuf::from(".antigravity_localization_cache")
    }
}

/// 定位白底 Hub 的 app.asar。候选路径与端点补丁共用同一份发现逻辑
/// （platforms::antigravity_hub_asar_candidates），避免汉化与 BYOK 各写一套、
/// 不同用户名 / 自定义安装路径 / 三平台下出现漂移。
pub(crate) fn hub_asar_path() -> Option<PathBuf> {
    super::platforms::antigravity_hub_asar_candidates()
        .into_iter()
        .find(|p| p.exists())
}

pub(crate) fn ide_workbench_html_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir()?;
        let p = local
            .join("Programs")
            .join("Antigravity IDE")
            .join("resources")
            .join("app")
            .join("out")
            .join("vs")
            .join("code")
            .join("electron-browser")
            .join("workbench")
            .join("workbench.html");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "macos")]
    {
        let p = PathBuf::from("/Applications/Antigravity IDE.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "linux")]
    {
        let p = PathBuf::from("/usr/share/antigravity-ide/resources/app/out/vs/code/electron-browser/workbench/workbench.html");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
}

pub(crate) fn ide_product_json_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir()?;
        let p = local
            .join("Programs")
            .join("Antigravity IDE")
            .join("resources")
            .join("app")
            .join("product.json");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "macos")]
    {
        let p =
            PathBuf::from("/Applications/Antigravity IDE.app/Contents/Resources/app/product.json");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "linux")]
    {
        let p = PathBuf::from("/usr/share/antigravity-ide/resources/app/product.json");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
}

pub(super) fn read_cached_version() -> String {
    let meta_path = cache_dir().join("metadata.json");
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(v) = val.get("version").and_then(|v| v.as_str()) {
                return v.to_string();
            }
        }
    }
    CURRENT_EMBEDDED_VERSION.to_string()
}

/// 本地缓存的词库内容指纹（metadata.json 的 sha 字段）。
/// 空 = 从未同步过（还在跑内置基线）→ 视为有更新。
pub(super) fn read_cached_sha() -> String {
    let meta_path = cache_dir().join("metadata.json");
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(v) = val.get("sha").and_then(|v| v.as_str()) {
                return v.to_string();
            }
        }
    }
    String::new()
}


pub mod hub_patch;
pub(crate) use hub_patch::*;

fn restore_ide_workbench(html_path: &Path, product_json: &Path) -> Result<(), String> {
    let bak_path = html_path.with_file_name("workbench.html.lang.bak");
    if bak_path.exists() {
        let _ = fs::copy(&bak_path, html_path);
        let _ = fs::remove_file(&bak_path);
    } else if let Ok(html) = fs::read_to_string(html_path) {
        let cleaned = html.replace("<script src=\"antigravity-hans-overlay.js\"></script>", "");
        let _ = fs::write(html_path, cleaned.as_bytes());
    }

    let workbench_dir = html_path.parent();
    if let Some(dir) = workbench_dir {
        let overlay = dir.join("antigravity-hans-overlay.js");
        if overlay.exists() {
            let _ = fs::remove_file(overlay);
        }
    }

    let prod_bak = product_json.with_file_name("product.json.lang.bak");
    if prod_bak.exists() {
        let _ = fs::copy(&prod_bak, product_json);
        let _ = fs::remove_file(&prod_bak);
    }
    Ok(())
}

/// 状态查询结果缓存：界面会在页面加载、打开面板、apply/restore 后反复查状态，
/// 每次都读 asar/磁盘太浪费。3 秒 TTL 足够覆盖连续查询，apply/restore 主动失效。
static STATUS_CACHE: std::sync::OnceLock<
    std::sync::Mutex<Option<(std::time::Instant, AntigravityLocalizationStatus)>>,
> = std::sync::OnceLock::new();
const STATUS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3);

fn invalidate_status_cache() {
    if let Some(m) = STATUS_CACHE.get() {
        if let Ok(mut slot) = m.lock() {
            *slot = None;
        }
    }
}

fn build_antigravity_status(target: &str) -> AntigravityLocalizationStatus {
    let is_ide = target == "antigravity-ide";
    let (installed, localized) = if is_ide {
        if let Some(html) = ide_workbench_html_path() {
            (true, is_ide_localized(&html))
        } else {
            (false, false)
        }
    } else {
        if let Some(asar) = hub_asar_path() {
            (true, is_hub_localized(&asar))
        } else {
            (false, false)
        }
    };

    AntigravityLocalizationStatus {
        target: target.to_string(),
        installed,
        localized,
        current_version: read_cached_version(),
        latest_version: None,
        has_update: false,
        release_name: None,
        release_url: None,
        published_at: None,
        message: None,
    }
}

#[tauri::command]
pub async fn get_antigravity_localization_status(
    target: String,
) -> Result<AntigravityLocalizationStatus, String> {
    // 异步 + spawn_blocking：磁盘读绝不占 Tauri 主线程（否则点按钮观感卡顿）
    tauri::async_runtime::spawn_blocking(move || {
        let cache = STATUS_CACHE.get_or_init(|| std::sync::Mutex::new(None));
        {
            let slot = cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((ts, st)) = slot.as_ref() {
                if ts.elapsed() < STATUS_CACHE_TTL && st.target == target {
                    return Ok(st.clone());
                }
            }
        }
        let st = build_antigravity_status(&target);
        if let Ok(mut slot) = cache.lock() {
            *slot = Some((std::time::Instant::now(), st.clone()));
        }
        Ok(st)
    })
    .await
    .map_err(|e| format!("状态查询任务失败: {}", e))?
}

/// async + spawn_blocking：patch_hub_asar 是重文件 IO（读改写 asar 包），
/// 同步 command 在 Tauri 主线程执行会冻结 UI。
#[tauri::command]
pub async fn apply_antigravity_localization(
    target: String,
) -> Result<LocalizationOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply_antigravity_localization_sync(target))
        .await
        .map_err(|e| format!("汉化任务执行失败: {e}"))?
}

fn apply_antigravity_localization_sync(
    target: String,
) -> Result<LocalizationOperationResult, String> {
    let _t0 = std::time::Instant::now();
    eprintln!("[ag-loc] apply sync 开始");
    let is_ide = target == "antigravity-ide";
    let plat_name = if is_ide {
        "Antigravity IDE"
    } else {
        "Antigravity"
    };

    if is_ide {
        // IDE 界面汉化已移除：它需要改写 IDE 安装包资源并清空校验和，
        // 官方升级后会失效甚至影响启动，风险高于收益。
        // 还原能力保留（见 restore_antigravity_localization），用于清理历史汉化。
        return Err(
            "Antigravity IDE 的界面汉化功能已移除。如需清理历史汉化，请点击「还原官方英文」"
                .to_string(),
        );
    }

    // 持全局注入锁：BYOK 接入（platforms::apply_antigravity_with_stash）同样会
    // 全量重写这个 app.asar，两边不互斥就是典型 lost update（后写方用旧 bytes
    // 覆盖前一个的补丁）。
    let _guard = super::inject_lock();
    let asar_path = hub_asar_path()
        .ok_or_else(|| "未找到 Antigravity 桌面端安装目录，请先安装该应用".to_string())?;
    patch_hub_asar(&asar_path)?;
    invalidate_status_cache();

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!("{} 汉化已应用成功，重启客户端后生效", plat_name),
        localized: true,
    })
}

/// async + spawn_blocking：restore_hub_asar / restore_ide_workbench 是重文件 IO。
#[tauri::command]
pub async fn restore_antigravity_localization(
    target: String,
) -> Result<LocalizationOperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore_antigravity_localization_sync(target))
        .await
        .map_err(|e| format!("还原任务执行失败: {e}"))?
}

fn restore_antigravity_localization_sync(
    target: String,
) -> Result<LocalizationOperationResult, String> {
    // 持全局注入锁：与汉化 apply、BYOK 接入/还原互斥（同上，app.asar / workbench
    // 都是"全量读改写"，必须串行）。
    let _guard = super::inject_lock();
    let is_ide = target == "antigravity-ide";
    let plat_name = if is_ide {
        "Antigravity IDE"
    } else {
        "Antigravity"
    };

    if is_ide {
        let html_path = ide_workbench_html_path()
            .ok_or_else(|| "未找到 Antigravity IDE 安装目录".to_string())?;
        let product_json = ide_product_json_path()
            .unwrap_or_else(|| html_path.parent().unwrap().join("product.json"));
        restore_ide_workbench(&html_path, &product_json)?;
    } else {
        let asar_path =
            hub_asar_path().ok_or_else(|| "未找到 Antigravity 桌面端安装目录".to_string())?;
        restore_hub_asar(&asar_path)?;
    }
    invalidate_status_cache();

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!("{} 已还原为官方英文原版，重启客户端后生效", plat_name),
        localized: false,
    })
}

#[tauri::command]
pub async fn check_antigravity_localization_update() -> Result<AntigravityLocalizationStatus, String>
{
    // 不再打 api.github.com releases API：未认证限额 60 次/小时按出口 IP 计，
    // Clash 共享节点必被耗尽（实测 HTTP 403）。改为 raw 直下上游 localize.js
    // 后做内容哈希比对——raw 是 CDN 不设限，镜像兜底见 fetch_github_content。
    let content = super::fetch_github_content(UPSTREAM_RAW_URL, 30).await?;
    let remote_sha = super::content_sha256(&content);
    let current = read_cached_version();
    let has_update = read_cached_sha() != remote_sha;

    Ok(AntigravityLocalizationStatus {
        target: "antigravity".to_string(),
        installed: true,
        localized: true,
        current_version: current,
        latest_version: Some(remote_sha[..8.min(remote_sha.len())].to_string()),
        has_update,
        release_name: None,
        release_url: None,
        published_at: None,
        message: None,
    })
}

#[tauri::command]
pub async fn download_antigravity_localization_update(
) -> Result<LocalizationOperationResult, String> {
    // 直接下载 raw（镜像兜底），不再先调 check——那会白下载一次。
    let content = super::fetch_github_content(UPSTREAM_RAW_URL, 60).await?;
    let remote_sha = super::content_sha256(&content);

    let (override_js, count) = extract_dictionary_override(&content).ok_or_else(|| {
        "上游脚本结构变化，未能解析出汉化词典（已保留内置离线词库不受影响）".to_string()
    })?;
    // 写盘前自检：坏覆盖块拼进 preload.js 顶层 = 客户端起不来，宁可拒绝更新
    if !is_safe_dict_override(&override_js) {
        return Err(
            "上游词库覆盖块未通过自检（非预期格式），已保留现有词库不受影响".to_string(),
        );
    }

    fs::write(
        cache_dir().join("antigravity-hub-dict.js"),
        override_js.as_bytes(),
    )
    .map_err(|e| format!("写入热更新词库缓存失败: {e}"))?;
    let meta_json = json!({
        "version": remote_sha[..8.min(remote_sha.len())],
        "sha": remote_sha,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "entries": count
    });
    fs::write(
        cache_dir().join("metadata.json"),
        meta_json.to_string().as_bytes(),
    )
    .map_err(|e| format!("写入词库版本记录失败: {e}"))?;

    Ok(LocalizationOperationResult {
        ok: true,
        message: format!(
            "已同步上游最新汉化词库（{} 条词条），请重新应用汉化生效",
            count
        ),
        localized: true,
    })
}


#[cfg(test)]
mod tests;
