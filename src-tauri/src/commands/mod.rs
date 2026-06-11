pub mod cert_install;
pub mod config;
pub mod eval;
pub mod ide_config;
pub mod ide_models;
pub mod model_map;
pub mod provider_import;
pub mod proxy;
pub mod system;
pub mod update;
pub mod windsurf_catalog;
pub mod workbench_inject;

use std::path::Path;

/// 原子写：先写同目录临时文件再 rename 覆盖，避免写入中途崩溃留下截断文件。
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("byok-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}
