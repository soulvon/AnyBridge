# 发布流程

[English](RELEASE.md) • [简体中文](RELEASE_zh.md)

AnyBridge 使用 GitHub Actions 构建发布包产物与 Tauri 更新元数据。

## 版本管理

每次发布时，需保持以下文件的版本号严格一致：

- `package.json`
- `package-lock.json`
- `sidecar/package.json`
- `sidecar/package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`（随 Cargo.toml 自动更新）
- `src-tauri/tauri.conf.json`
- `CHANGELOG.md`

开源版本线从 `0.1.0` 开始。

严禁将本地构建产物（`src-tauri/binaries/`、`src-tauri/target/`）、临时探针脚本或凭据导出文件提交到仓库。

## 历史更新器迁移 (Legacy Updater Migration)

现有的 `1.x` 历史构建无法通过默认的 Tauri 更新器比较直接升级到 `0.1.0`。因为 `0.1.0` 低于 `1.2.18`，旧客户端会视其为降级并提示无可用更新。

迁移老用户时，需使用桥接版本策略：

1. 构建并发布一个高于最后一个历史版本的临时桥接版本，例如 `1.2.19`。
2. 桥接构建必须包含 `src-tauri/src/commands/update.rs` 中的显式版本重置比较器（只允许 `1.x -> 0.1.0`，不放开任意降级）。
3. 先发布 `v1.2.19` 作为更新器的最新版本，现有 `1.2.18` 客户端将把它视作常规更新。
4. 验证桥接版本覆盖后，再发布 `v0.1.0` 作为更新器最新版。桥接客户端将检测到明确的重置目标，并通过常规更新界面安装。
5. 在公开推开前，需在 Windows 真机上完整验证升级路径：`1.2.18 -> 1.2.19 -> 0.1.0`。

## 本地构建

构建 sidecar：

```bash
python scripts/build/build_sidecar_plain.py
```

为特定目标构建 sidecar：

```bash
python scripts/build/build_sidecar_plain.py --platform x86_64-pc-windows-msvc
python scripts/build/build_sidecar_plain.py --platform aarch64-apple-darwin
python scripts/build/build_sidecar_plain.py --platform x86_64-apple-darwin
python scripts/build/build_sidecar_plain.py --platform x86_64-unknown-linux-gnu
```

构建不带更新器产物的本地安装包：

```bash
npm run tauri:build:local
```

## 签名发布流程

发布工作流需要以下仓库 Secrets：
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

私钥文件 `tauri-sign.key` 严禁提交至 Git。

## 发布步骤

1. 更新各文件版本号，并在 `CHANGELOG.md` 中编写新版本章节（`## vX.Y.Z`）。
2. 在 `main` 分支上提交发布修改。
3. 推送提交，并创建与推送对应版本的附注标签：

   ```bash
   git push origin main
   git tag -a v0.3.7 -m "release: v0.3.7"
   git push origin v0.3.7
   ```

4. 标签推送将触发 `.github/workflows/release.yml` 自动化构建。
5. 验证 Actions 运行及全平台产物与 `latest.json`。
6. 产物核对无误后正式发布 Draft Release。
