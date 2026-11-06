//! 插件发布包获取（GitHub Releases 预编译二进制）。
//!
//! 和 CPA（CLIProxyAPI / CPA Manager Plus）走的是同一条链路：
//!   解析版本 → 并发测速挑最快镜像 → 流式下载（系统代理）→ 逐镜像重试 → 解压 → 就位。
//! 插件侧只声明「要哪个仓库的哪个产物」，不再各自实现下载。
//!
//! 为什么不让 adapter 用 curl 自己下：
//!   curl.exe 用自带 CA 包，企业网 / 本机代理（Clash 等）中间证书环境下会直接 60 失败；
//!   Rust 侧 reqwest 走系统代理 + 镜像测速，与 CPA 安装部署在用户机器上的成功路径一致。
//!
//! 安装只替换可执行文件：config、凭证目录、数据目录一律不碰。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use super::extensions::{self, DownloadProgress};

/// 卸载时 adapter 会把凭证与运行状态备份到 `~/.anybridge/<pluginId>-backup-<时间戳>/`
/// （见 adapter 的 prepareUninstall）。再次安装时把它们放回去 —— 卸载重装不该
/// 让用户把账号重新登录一遍。
///
/// 只拷回安装目录里**还没有**的目录：已有的一律不动，绝不覆盖更新的数据。
/// 返回一句可展示的说明（恢复了哪些目录、来自哪份备份）。
pub(crate) fn restore_latest_backup(plugin_id: &str, install_path: &Path) -> Option<String> {
    let backup_root = dirs::home_dir()?.join(".anybridge");
    let prefix = format!("{}-backup-", plugin_id);

    let mut candidates: Vec<PathBuf> = fs::read_dir(&backup_root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix)))
        .collect();
    // 目录名末尾是 ISO 时间戳，字典序即时间序，最后一个就是最近一次卸载的备份
    candidates.sort();
    let latest = candidates.pop()?;

    let mut restored = Vec::new();
    for dir in ["auths", "data"] {
        let from = latest.join(dir);
        let to = install_path.join(dir);
        if !from.is_dir() || to.exists() {
            continue;
        }
        if copy_dir_recursive(&from, &to).is_ok() {
            restored.push((*dir).to_string());
        }
    }

    if restored.is_empty() {
        None
    } else {
        Some(format!(
            "{}（来自 {}）",
            restored.join("、"),
            latest.display()
        ))
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("无法创建目录 {}：{}", to.display(), e))?;
    for entry in fs::read_dir(from)
        .map_err(|e| format!("无法读取备份目录 {}：{}", from.display(), e))?
        .flatten()
    {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else if src.is_file() {
            fs::copy(&src, &dst).map_err(|e| format!("无法复制 {}：{}", src.display(), e))?;
        }
    }
    Ok(())
}

/// 插件在 plugin.json 的 `deploy.asset` 里声明的发布包规格。
#[derive(Debug, Clone)]
pub(crate) struct ReleaseAssetSpec {
    /// GitHub 仓库，如 Practice019/multi2api
    pub repo: String,
    /// 产物名模板，支持 {tag} {version} {goos} {goarch} {archive_ext}
    /// 上游把版本号嵌进文件名时必须用 {tag}：只有拿到 release tag 才知道该下哪个文件。
    asset_template: String,
    /// 可执行文件名模板，支持 {ext}
    binary_template: String,
    /// 记录已安装版本的文件名（相对安装目录）
    version_file: String,
    /// 解压时剥离的顶层目录层数
    strip_components: usize,
}

impl ReleaseAssetSpec {
    /// manifest.deploy 中声明了 asset 才返回 Some；字段缺失直接报错，不做静默兜底。
    pub(crate) fn from_deploy(deploy: &serde_json::Value) -> Result<Option<Self>, String> {
        let Some(asset) = deploy.get("asset") else {
            return Ok(None);
        };
        if asset.is_null() {
            return Ok(None);
        }

        let field = |key: &str| -> Result<String, String> {
            asset
                .get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("plugin.json 的 deploy.asset.{} 缺失或为空", key))
        };

        Ok(Some(Self {
            repo: field("repo")?,
            asset_template: field("name")?,
            binary_template: field("binary")?,
            version_file: asset
                .get("versionFile")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| ".release-version".to_string()),
            strip_components: asset
                .get("stripComponents")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize,
        }))
    }

    fn goos() -> &'static str {
        match std::env::consts::OS {
            "windows" => "windows",
            "macos" => "darwin",
            _ => "linux",
        }
    }

    fn goarch() -> &'static str {
        match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            "x86" => "386",
            other => other,
        }
    }

    fn exe_ext() -> &'static str {
        if cfg!(windows) {
            ".exe"
        } else {
            ""
        }
    }

    fn archive_ext() -> &'static str {
        if cfg!(windows) {
            "zip"
        } else {
            "tar.gz"
        }
    }

    /// 把模板展开成 release 资产名。`tag` 是原样版本号（如 v0.3.1），
    /// `{version}` 则是去掉开头 v 的版本号，供不带 v 的命名习惯使用。
    pub(crate) fn asset_name(&self, tag: &str) -> String {
        let version = tag.strip_prefix('v').unwrap_or(tag);
        self.asset_template
            .replace("{tag}", tag)
            .replace("{version}", version)
            .replace("{goos}", Self::goos())
            .replace("{goarch}", Self::goarch())
            .replace("{archive_ext}", Self::archive_ext())
    }

    pub(crate) fn binary_name(&self) -> String {
        self.binary_template.replace("{ext}", Self::exe_ext())
    }

    pub(crate) fn installed_version(&self, install_path: &Path) -> Option<String> {
        let raw = fs::read_to_string(install_path.join(&self.version_file)).ok()?;
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }

    fn binary_path(&self, install_path: &Path) -> PathBuf {
        install_path.join(self.binary_name())
    }
}

/// 确保发布包已就位，返回实际安装的版本号。
///
/// - `version = None` 表示取最新版本；`force = false` 时若本地已有二进制与版本记录则直接返回。
/// - 下载进度通过 `progress(message, percent)` 投递，百分比区间 20~85，留给后续配置步骤。
pub(crate) async fn install(
    plugin_id: &str,
    spec: &ReleaseAssetSpec,
    install_path: &Path,
    version: Option<&str>,
    force: bool,
    progress: DownloadProgress<'_>,
) -> Result<String, String> {
    fs::create_dir_all(install_path)
        .map_err(|e| format!("无法创建安装目录 {}：{}", install_path.display(), e))?;

    // 只有「装最新版」才允许命中已安装直接返回；指定版本时一律按目标版本重新取包
    if !force && version.is_none() {
        if let Some(installed) = spec.installed_version(install_path) {
            if spec.binary_path(install_path).is_file() {
                progress(&format!("已安装 {}，跳过下载", installed), 85);
                return Ok(installed);
            }
        }
    }

    // 资产名里可能含 {tag}：先定版本号再展开模板，才能精确匹配含版本号的 release 资产。
    // 未指定版本时在这里取 latest，并把它显式传给 resolve_release_asset，
    // 避免「拼文件名」与「查资产列表」各请求一次版本号。
    let tag = match version {
        Some(v) => v.trim().to_string(),
        None => extensions::latest_release_tag(&spec.repo).await?,
    };
    if tag.is_empty() {
        return Err(format!("无法解析 {} 的发布版本号", spec.repo));
    }
    let asset_name = spec.asset_name(&tag);
    let (resolved_tag, url) =
        extensions::resolve_release_asset(&spec.repo, Some(&tag), &asset_name).await?;
    progress(&format!("准备下载 {}（版本 {}）", asset_name, resolved_tag), 20);

    let download_name = format!("anybridge_{}_{}", plugin_id, asset_name);
    let archive = extensions::download_asset_with(&url, &download_name, progress, 20, 85).await?;

    let result = unpack_binary(plugin_id, spec, install_path, &archive, &resolved_tag);
    let _ = fs::remove_file(&archive);
    result?;

    progress(&format!("{} 已就位（版本 {}）", spec.binary_name(), resolved_tag), 85);
    Ok(resolved_tag)
}

fn unpack_binary(
    plugin_id: &str,
    spec: &ReleaseAssetSpec,
    install_path: &Path,
    archive: &Path,
    tag: &str,
) -> Result<(), String> {
    let staging = install_path.join(format!(".{}-staging", plugin_id));
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|e| format!("无法清理暂存目录 {}：{}", staging.display(), e))?;
    }
    fs::create_dir_all(&staging)
        .map_err(|e| format!("无法创建暂存目录 {}：{}", staging.display(), e))?;

    if let Err(e) = extract_stripped(archive, &staging, spec.strip_components) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    let staged_bin = staging.join(spec.binary_name());
    if !staged_bin.is_file() {
        let listing = list_files(&staging).unwrap_or_else(|_| "（无法列出）".to_string());
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "发布包 {} 中没有找到 {}。包内文件：{}",
            archive
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("archive"),
            spec.binary_name(),
            listing
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&staged_bin, fs::Permissions::from_mode(0o755));
    }

    let target = spec.binary_path(install_path);
    let replaced = replace_file(&staged_bin, &target);
    let _ = fs::remove_dir_all(&staging);
    replaced?;

    fs::write(install_path.join(&spec.version_file), tag)
        .map_err(|e| format!("无法写入版本记录 {}：{}", spec.version_file, e))?;
    Ok(())
}

/// 用 rename 覆盖目标文件。Windows 上进程刚退出时文件句柄释放有延迟，
/// 这里给一个有限的等待窗口；窗口内让不出来就如实报错，绝不假装替换成功。
fn replace_file(staged: &Path, target: &Path) -> Result<(), String> {
    let mut last_err = String::new();
    for attempt in 0..20u32 {
        match fs::rename(staged, target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                if attempt < 19 {
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        }
    }
    Err(format!(
        "无法替换 {}：{}。若插件仍在运行，请先停止服务再重试。",
        target.display(),
        last_err
    ))
}

fn list_files(dir: &Path) -> Result<String, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    names.sort();
    Ok(names.join("、"))
}

fn extract_stripped(archive: &Path, target: &Path, strip: usize) -> Result<(), String> {
    let name = archive
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    if name.ends_with(".zip") {
        extract_zip(archive, target, strip)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz(archive, target, strip)
    } else {
        Err(format!(
            "不支持的发布包格式：{}（需要 .zip 或 .tar.gz）",
            archive.display()
        ))
    }
}

/// 去掉路径前 `strip` 层组件；路径本身不足 `strip` 层时返回 None（跳过，如顶层目录条目）。
/// 含 `..` 或绝对根的条目直接丢弃 —— 解压目标由压缩包内容决定是典型的越界写入。
fn strip_path(path: &Path, strip: usize) -> Option<PathBuf> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(_) => parts.push(component),
            // 绝对路径 / 上跳 / Windows 盘符前缀：一律不认
            _ => return None,
        }
    }
    if parts.len() <= strip {
        return None;
    }
    Some(parts[strip..].iter().collect())
}

fn extract_zip(archive: &Path, target: &Path, strip: usize) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("无法打开 zip 包：{}", e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("无效的 zip 包：{}", e))?;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("读取 zip 条目失败：{}", e))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue; // 越界路径（../）直接丢弃
        };
        let Some(rel) = strip_path(&enclosed, strip) else {
            continue;
        };
        let out = target.join(&rel);

        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("创建目录失败 {}：{}", out.display(), e))?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录失败 {}：{}", parent.display(), e))?;
            }
            let mut outfile = fs::File::create(&out)
                .map_err(|e| format!("创建文件失败 {}：{}", out.display(), e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("写入文件失败 {}：{}", out.display(), e))?;
        }
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, target: &Path, strip: usize) -> Result<(), String> {
    use flate2::read::GzDecoder;

    let file = fs::File::open(archive).map_err(|e| format!("无法打开 tar.gz 包：{}", e))?;
    let mut tar = tar::Archive::new(GzDecoder::new(file));
    let entries = tar.entries().map_err(|e| format!("读取 tar.gz 失败：{}", e))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("读取 tar.gz 条目失败：{}", e))?;
        let path = entry
            .path()
            .map_err(|e| format!("解析 tar.gz 条目路径失败：{}", e))?
            .to_path_buf();
        let Some(rel) = strip_path(&path, strip) else {
            continue;
        };
        let out = target.join(&rel);

        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("创建目录失败 {}：{}", out.display(), e))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}：{}", parent.display(), e))?;
        }
        entry
            .unpack(&out)
            .map_err(|e| format!("解压文件失败 {}：{}", out.display(), e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(template: &str) -> ReleaseAssetSpec {
        ReleaseAssetSpec {
            repo: "Mag1cFall/AIStudio2API".to_string(),
            asset_template: template.to_string(),
            binary_template: "aistudio2api{ext}".to_string(),
            version_file: ".aistudio2api-version".to_string(),
            strip_components: 1,
        }
    }

    #[test]
    fn asset_name_expands_tag_and_platform_placeholders() {
        let name = spec("aistudio2api-{tag}-{goos}-{goarch}.{archive_ext}").asset_name("v0.3.1");
        // 期望值独立手写，不复用被测实现去拼装
        assert!(name.starts_with("aistudio2api-v0.3.1-"), "实际：{name}");
        assert!(!name.contains('{') && !name.contains('}'), "占位符未展开：{name}");
        assert!(
            name.ends_with(if cfg!(windows) { ".zip" } else { ".tar.gz" }),
            "实际：{name}"
        );
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[test]
    fn asset_name_matches_upstream_windows_release() {
        assert_eq!(
            spec("aistudio2api-{tag}-{goos}-{goarch}.{archive_ext}").asset_name("v0.3.1"),
            "aistudio2api-v0.3.1-windows-amd64.zip"
        );
    }

    #[test]
    fn version_placeholder_drops_v_prefix() {
        let name = spec("aistudio2api-{version}-{goos}-{goarch}.{archive_ext}").asset_name("v0.3.1");
        assert!(name.starts_with("aistudio2api-0.3.1-"), "实际：{name}");
        assert!(!name.contains('{'), "占位符未展开：{name}");
    }

    #[test]
    fn templates_without_tag_still_expand() {
        let name = spec("wb2api-server-{goos}-{goarch}.{archive_ext}").asset_name("v1.7.3");
        assert!(name.starts_with("wb2api-server-"), "实际：{name}");
        assert!(!name.contains('{'), "占位符未展开：{name}");
    }

    #[test]
    fn from_deploy_rejects_incomplete_asset() {
        let deploy = serde_json::json!({ "asset": { "repo": "x/y", "name": "a.zip" } });
        let err = ReleaseAssetSpec::from_deploy(&deploy).unwrap_err();
        assert!(err.contains("binary"), "实际：{err}");
    }

    #[test]
    fn strip_path_discards_traversal_and_strips_top_dir() {
        assert!(strip_path(Path::new("../evil"), 1).is_none());
        assert_eq!(
            strip_path(Path::new("aistudio2api-v0.3.1-windows-amd64/aistudio2api.exe"), 1).unwrap(),
            PathBuf::from("aistudio2api.exe")
        );
    }
}

