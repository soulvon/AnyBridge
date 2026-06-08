# Tauri 2.x 配置自查清单

> 每次 `cargo tauri build` 前逐项检查

## 🔴 必查（不做就出 bug）

- [ ] `tauri.conf.json` → `security.dangerousDisableAssetCspModification` 包含 `["style-src"]`
  - 没有这个 → 生产构建样式丢失，dev 正常
- [ ] `tauri.conf.json` → `security.csp` 中 `style-src` 包含 `'unsafe-inline'`
  - 没有这个 → JS 动态 style 被阻塞
- [ ] `tauri.conf.json` → `bundle.targets` 是字符串 `"all"`，不是数组
  - 数组格式 → schema 验证失败
- [ ] Sidecar 文件名包含 target triple（如 `ide-byok-proxy-x86_64-pc-windows-msvc.exe`）
  - 缺 triple → Tauri 找不到 sidecar

## 🟡 常见坑

- [ ] Rust `windows-sys` 底层 API（CONTEXT/GetThreadContext 等）→ 用 raw `extern "system"` FFI
  - 用 windows-sys 模块路径 → 编译失败，feature gate 混乱
- [ ] `#[repr(C)]` 结构体初始化 → 用 `std::mem::zeroed()`，不用 `#[derive(Default)]`
  - Default → `[u8; N]` 大数组不实现 Default
- [ ] 仅 release 使用的模块 → `#[allow(dead_code)] mod xxx`
  - 不加 → dev 编译 12 个 warning
- [ ] 编译前杀旧 EXE 进程 → `Stop-Process -Name "xxx" -Force`
  - 不杀 → os error 5 拒绝访问
- [ ] Windows 生产 origin 是 `http://tauri.localhost`（不是 https）
  - 升级项目 → LocalStorage/Cookie 重置

## 🟢 优化建议

- [ ] CSP 中 `script-src` 保留 hash 保护（只禁用 style-src 的自动注入）
- [ ] `connect-src` 包含 `ipc: http://ipc.localhost`（Tauri IPC 需要）
- [ ] `font-src 'self'`（本地字体文件需要）
- [ ] `img-src 'self' data:`（base64 图片需要）
