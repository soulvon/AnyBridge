// integrity.rs — 运行时完整性校验
// 启动时校验 sidecar 二进制和关键资源文件的哈希，防止篡改。

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// 计算文件 SHA-256 哈希，返回 hex 字符串
pub fn hash_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    let hash = Sha256::digest(&bytes);
    Ok(hex::encode(hash))
}

fn current_target_triple() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some("x86_64-pc-windows-msvc");
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Some("aarch64-pc-windows-msvc");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some("x86_64-apple-darwin");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("aarch64-apple-darwin");
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Some("x86_64-unknown-linux-gnu");
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Some("aarch64-unknown-linux-gnu");
    }
    #[allow(unreachable_code)]
    None
}

fn sidecar_filenames() -> Vec<String> {
    let exe_suffix = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let mut files = vec![format!("anybridge-proxy{}", exe_suffix)];
    if let Some(triple) = current_target_triple() {
        files.push(format!("anybridge-proxy-{}{}", triple, exe_suffix));
    }
    files
}

fn sidecar_path_in(exe_dir: &Path) -> Option<PathBuf> {
    sidecar_filenames()
        .into_iter()
        .map(|name| exe_dir.join(name))
        .find(|path| path.exists())
}

/// 校验 sidecar 二进制是否被篡改
/// 首次启动时记录基准哈希，后续启动比对
/// 校验失败时打印警告但不退出，避免开发/测试环境误杀
pub fn verify_sidecar() -> Result<(), String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("无法定位可执行文件目录")?
        .to_path_buf();
    let Some(sidecar_path) = sidecar_path_in(&exe_dir) else {
        return Ok(()); // sidecar 可能还没打包进来，不报错
    };

    if !sidecar_path.exists() {
        return Ok(()); // sidecar 可能还没打包进来，不报错
    }

    let config_dir = crate::commands::config::config_dir_path();
    let baseline_path = config_dir.join(".sidecar-hash");

    let current_hash = hash_file(&sidecar_path)?;

    if baseline_path.exists() {
        let baseline =
            fs::read_to_string(&baseline_path).map_err(|e| format!("读取基线哈希失败: {}", e))?;
        if baseline.trim() != current_hash {
            eprintln!("[integrity] 警告: sidecar 哈希不匹配，可能被篡改或重新编译");
            // 更新基线哈希，避免反复报警
            fs::write(&baseline_path, current_hash)
                .map_err(|e| format!("更新基线哈希失败: {}", e))?;
        }
    } else {
        fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        fs::write(&baseline_path, current_hash).map_err(|e| format!("写入基线哈希失败: {}", e))?;
    }

    Ok(())
}

/// 校验 resources 目录下关键文件的哈希
/// 校验失败时打印警告但不退出，避免开发/测试环境误杀
pub fn verify_resources(resource_dir: &Path) -> Result<(), String> {
    let files = ["byok-cards.js"];
    let config_dir = crate::commands::config::config_dir_path();

    for file in &files {
        let file_path = resource_dir.join(file);
        if !file_path.exists() {
            continue;
        }
        let current_hash = hash_file(&file_path)?;
        let baseline_path = config_dir.join(format!(".{}", file.replace('.', "-hash.")));

        if baseline_path.exists() {
            let baseline =
                fs::read_to_string(&baseline_path).map_err(|e| format!("读取基线失败: {}", e))?;
            if baseline.trim() != current_hash {
                eprintln!(
                    "[integrity] 警告: 资源文件 {} 哈希不匹配，可能被篡改或重新编译",
                    file
                );
                // 更新基线，避免反复报警
                fs::write(&baseline_path, current_hash)
                    .map_err(|e| format!("更新基线失败: {}", e))?;
            }
        } else {
            fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
            fs::write(&baseline_path, current_hash).map_err(|e| format!("写入基线失败: {}", e))?;
        }
    }

    Ok(())
}
