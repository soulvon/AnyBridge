// windsurf_catalog.rs — 加载内置的 Windsurf 模型目录给 UI
//
// 数据源: sidecar/windsurf-catalog.json (构建时由 _gen_catalog_json.cjs 生成)
// 用途: UI「注入项配置」页展示 128 个 Windsurf 真实模型 label + modelUid + apiId

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub label: String,
    #[serde(rename = "modelUid")]
    pub model_uid: String,
    #[serde(rename = "apiId")]
    pub api_id: Option<String>,
    #[serde(rename = "contextWindow")]
    pub context_window: u32,
    #[serde(rename = "supportsImages")]
    pub supports_images: bool,
    #[serde(rename = "noApiIdHint", skip_serializing_if = "Option::is_none")]
    pub no_api_id_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogResponse {
    pub models: Vec<CatalogEntry>,
}

// 查找 catalog.json: 优先 resource_dir (打包后) → 开发模式相对路径
fn catalog_path() -> Option<PathBuf> {
    // 1) 环境变量 BYOK_RESOURCE_DIR
    if let Ok(p) = std::env::var("BYOK_RESOURCE_DIR") {
        let cand = PathBuf::from(p)
            .join("sidecar")
            .join("windsurf-catalog.json");
        if cand.exists() {
            return Some(cand);
        }
    }
    // 2) 开发模式: 项目根 sidecar/
    if let Ok(cwd) = std::env::current_dir() {
        let cand = cwd.join("sidecar").join("windsurf-catalog.json");
        if cand.exists() {
            return Some(cand);
        }
        // 也试 src-tauri/..
        let cand2 = cwd.join("..").join("sidecar").join("windsurf-catalog.json");
        if cand2.exists() {
            return Some(cand2);
        }
    }
    // 3) 可执行文件旁
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let cand0 = parent
                .join("resources")
                .join("sidecar")
                .join("windsurf-catalog.json");
            if cand0.exists() {
                return Some(cand0);
            }
            let cand = parent.join("sidecar").join("windsurf-catalog.json");
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    None
}

#[tauri::command]
pub fn list_windsurf_catalog() -> Result<CatalogResponse, String> {
    let path = catalog_path().ok_or_else(|| {
        "windsurf-catalog.json 未找到。开发模式:确认在项目根目录运行;打包:确认 sidecar/windsurf-catalog.json 已包含在资源中".to_string()
    })?;
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析 catalog JSON 失败: {}", e))
}
