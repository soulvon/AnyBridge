// windsurf_catalog.rs — 加载内置的 Windsurf 模型目录给 UI
//
// 数据源: sidecar/windsurf-catalog.json (构建时由 _gen_catalog_json.cjs 生成)
// 用途: UI「注入项配置」页展示 128 个 Windsurf 真实模型 label + modelUid + apiId

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

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

const CATALOG_REL: (&str, &str) = ("sidecar", "windsurf-catalog.json");

fn catalog_rel() -> PathBuf {
    PathBuf::from(CATALOG_REL.0).join(CATALOG_REL.1)
}

// 查找 catalog.json: Tauri 资源目录 (打包) → 环境变量 → 开发模式相对路径 → 可执行文件旁
//
// 打包后必须用 Tauri 的 resource_dir 定位：各平台资源布局不同
// (Windows: exe 旁; macOS: *.app/Contents/Resources; Linux: /usr/lib/<app>),
// 靠 current_exe 拼相对路径只在 Windows 上碰巧成立，macOS/Linux 会直接找不到。
fn catalog_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let rel = catalog_rel();

    // 1) Tauri 资源目录。部分打包布局会把 resources/ 前缀一起带进资源目录，两种都试。
    if let Some(dir) = resource_dir {
        for base in [dir.join("resources"), dir.to_path_buf()] {
            let cand = base.join(&rel);
            if cand.exists() {
                return Some(cand);
            }
        }
    }

    // 2) 环境变量 BYOK_RESOURCE_DIR (sidecar 与手动调试)
    if let Ok(p) = std::env::var("BYOK_RESOURCE_DIR") {
        let cand = PathBuf::from(p).join(&rel);
        if cand.exists() {
            return Some(cand);
        }
    }

    // 3) 开发模式: 项目根 sidecar/
    if let Ok(cwd) = std::env::current_dir() {
        let cand = cwd.join(&rel);
        if cand.exists() {
            return Some(cand);
        }
        // 也试 src-tauri/..
        let cand2 = cwd.join("..").join(&rel);
        if cand2.exists() {
            return Some(cand2);
        }
    }

    // 4) 可执行文件旁
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for base in [
                parent.join("resources"),
                parent.to_path_buf(),
                parent.join("..").join("Resources"),
            ] {
                let cand = base.join(&rel);
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn list_windsurf_catalog(app: tauri::AppHandle) -> Result<CatalogResponse, String> {
    let resource_dir = app.path().resource_dir().ok();
    let path = catalog_path(resource_dir.as_deref()).ok_or_else(|| {
        "windsurf-catalog.json 未找到。开发模式:确认在项目根目录运行;打包:确认 sidecar/windsurf-catalog.json 已包含在资源中".to_string()
    })?;
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析 catalog JSON 失败: {}", e))
}
