# Changelog

## v1.2.7 - 2026-06-09

- 修复云端 sidecar 打包 target：从 `node20-*` 切换到 `node22-*`，并在 GitHub Actions 中显式预取对应的 `pkg` base binary，避免退回源码编译。

## v1.2.6 - 2026-06-09

- 修复云端发布流水线：使用 `npm ci`、官方 npm registry 和本地 `pkg` 可执行文件构建 sidecar，避免 GitHub Actions 在 sidecar 依赖安装阶段卡住。
- 同步根目录与 sidecar 锁文件的 registry 地址，提升 Windows、macOS 和 Linux 云端打包稳定性。

## v1.2.5 - 2026-06-09

- 优化 UI 结构：将单文件前端拆分为按职责组织的 HTML、CSS 和 JS 文件，降低后续迭代成本。
- 改进顶栏响应式和键盘交互：900px 最小窗口下导航保持可见，顶部 tab 与 IDE 选择器支持键盘和 ARIA 状态。
- 新增 `npm run check:ui`，用于检查 UI 脚本加载顺序、CSS import 顺序和 JS 语法。
- 收紧端口回收逻辑，避免误杀非本项目的 Node 进程。
- 修复 sidecar 构建脚本的项目根目录定位，保证发布前能正确重建代理二进制。
- 更新 README 和 UI 维护说明，使文档与当前 MITM 行为、日志策略和前端结构一致。
- 新增打包与更新发布指南，固定本地测试、云端多平台打包和公开 Release 仓库同步流程。
- 更新完成后弹出“更新成功”提示，并展示旧版本到新版本的升级结果。
