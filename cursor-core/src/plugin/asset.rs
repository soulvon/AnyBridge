//! Maps supported desktop platforms to pinned Deno release assets.
pub(super) const DENO_VERSION: &str = "2.9.6";

#[derive(Clone, Copy, Debug)]
pub(super) struct RuntimeAsset {
    pub target: &'static str,
    pub sha256: &'static str,
}

impl RuntimeAsset {
    pub fn current() -> Option<Self> {
        Self::for_platform(std::env::consts::OS, std::env::consts::ARCH)
    }

    pub(super) fn for_platform(os: &str, arch: &str) -> Option<Self> {
        let (target, sha256) = match (os, arch) {
            ("macos", "aarch64") => (
                "aarch64-apple-darwin",
                "213a2f304f04d3c9cb5220669afad138f60a5aab1fe80962abdeb8f35807a472",
            ),
            ("macos", "x86_64") => (
                "x86_64-apple-darwin",
                "7d4524b82bcc557fe020a1a5b56956ed42b992ae5b28026e8ad5d17329533f5f",
            ),
            ("windows", "aarch64") => (
                "aarch64-pc-windows-msvc",
                "acb014afe2299847764e232b4993e162e3946cdeec36603e3f1a0b548cd1ea55",
            ),
            ("windows", "x86_64") => (
                "x86_64-pc-windows-msvc",
                "15e5300b0ba3c3695a7621d90160a746ec9e710228cee639afa9d580f6e3cd11",
            ),
            ("linux", "aarch64") => (
                "aarch64-unknown-linux-gnu",
                "9a46afc6c392c7cd2ff71a31558935545b46408d0e87f7a86908c712721c046e",
            ),
            ("linux", "x86_64") => (
                "x86_64-unknown-linux-gnu",
                "394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2",
            ),
            _ => return None,
        };
        Some(Self { target, sha256 })
    }

    pub fn archive_name(self) -> String {
        format!("deno-{}.zip", self.target)
    }

    pub fn download_url(self) -> String {
        format!(
            "https://github.com/denoland/deno/releases/download/v{DENO_VERSION}/{}",
            self.archive_name()
        )
    }

    pub fn executable_name(self) -> &'static str {
        if self.target.contains("windows") {
            "deno.exe"
        } else {
            "deno"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_supported_desktop_target() {
        let cases = [
            ("macos", "aarch64", "aarch64-apple-darwin"),
            ("macos", "x86_64", "x86_64-apple-darwin"),
            ("windows", "aarch64", "aarch64-pc-windows-msvc"),
            ("windows", "x86_64", "x86_64-pc-windows-msvc"),
            ("linux", "aarch64", "aarch64-unknown-linux-gnu"),
            ("linux", "x86_64", "x86_64-unknown-linux-gnu"),
        ];
        for (os, arch, expected) in cases {
            assert_eq!(
                RuntimeAsset::for_platform(os, arch).unwrap().target,
                expected
            );
        }
        assert!(RuntimeAsset::for_platform("linux", "x86").is_none());
    }
}
