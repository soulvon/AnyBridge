# IDE BYOK 打包与更新发布指南

本文档作为后续固定打包流程。IDE BYOK 源码仓库保持私有，只把编译后的安装包、签名文件和 `latest.json` 同步到公开发布仓库。

## 发布架构

- 私有源码仓库：`soulvon/IDE-BYOK`，保存源码、CI、Tauri 配置和签名公钥。
- 公开分发仓库：`soulvon/IDE-BYOK-Release`，只承载 GitHub Release 资产，不放私有源码。
- 应用更新端点：`https://github.com/soulvon/IDE-BYOK-Release/releases/latest/download/latest.json`。
- Tauri updater 只信任 `src-tauri/tauri.conf.json` 中配置的 `pubkey`，安装包必须由对应私钥签名。

## 防篡改发布原则

目标不是让客户端二进制绝对不可逆，而是让篡改广告版、中转版、二次牟利版无法伪装成官方版本，并且不能接入官方更新链路。

- 日常开发不加保护：开发时继续运行原始 JS sidecar，保持调试速度。
- 本地测试默认轻量：本地安装包可用普通 sidecar，只在需要验收保护链路时手动构建 protected sidecar。
- 正式发布必须加保护：云端 release 包应使用 protected sidecar，并由 Tauri updater 私钥签名。
- 官方身份可验证：正式包后续应显示“官方构建：已验证/未验证”，篡改包无法通过验证。
- 私钥只在 CI Secret：签名私钥、代码签名证书、发布 token 不能进入源码仓库或公开分发仓库。

### 分阶段规划

| 阶段 | 内容 | 开发影响 | 发布影响 |
| :--- | :--- | :--- | :--- |
| P0 | 保持私有源码仓库，公开仓库只发安装包和 `latest.json` | 无 | 已采用 |
| P1 | 正式 release 改用 `scripts/build/build_protected_sidecar.py` | 无 | release 构建变慢几十秒到数分钟 |
| P2 | 构建时生成签名完整性清单，启动时校验主程序、sidecar、关键资源 | debug 跳过 | release 启动增加少量校验耗时 |
| P3 | Windows Authenticode、macOS Developer ID + notarization | 无 | CI 多证书和公证步骤 |
| P4 | 将核心代理逻辑迁移到 Rust/Go | 有明显开发成本 | 逆向成本进一步提高 |

当前优先执行 P0-P2。P3 等证书准备好后再纳入云端 release；P4 不进入近期打包流程，避免拖慢功能开发。

## 一、本地打包测试

本地打包只用于验证安装包可启动、UI 可用、sidecar 能运行。默认不生成 updater 签名资产，不发布给用户，也不要求启用所有防篡改措施。

### 1. 准备环境

- Windows 11 本机测试：Node.js 20+、Rust stable、Tauri CLI、Visual Studio Build Tools、WiX/NSIS 依赖。
- macOS/Linux 测试建议在对应系统本机或 GitHub Actions runner 上构建，不建议在 Windows 上交叉编译桌面包。
- 打包前关闭正在运行的 IDE BYOK 和 `ide-byok-proxy`，避免安装包覆盖 sidecar 时文件被占用。

### 2. 同步版本号

本地测试版本也要保持三处一致：

- `package.json` 的 `version`
- `src-tauri/Cargo.toml` 的 `package.version`
- `src-tauri/tauri.conf.json` 的 `version`

同时按需更新 `CHANGELOG.md`，这样更新成功弹窗和后续 release notes 才能对齐。

### 3. 安装依赖

```powershell
npm install
Push-Location sidecar
npm install
Pop-Location
```

### 4. 构建 sidecar

快速功能测试使用普通 sidecar：

```powershell
python scripts/build/build_sidecar_plain.py
```

需要验证防提取构建时使用保护版 sidecar。这个命令只在本地验收保护效果时运行，不作为日常开发必需步骤：

```powershell
python scripts/build/build_protected_sidecar.py
```

Windows 本地输出应包含：

```text
src-tauri/binaries/ide-byok-proxy-x86_64-pc-windows-msvc.exe
```

### 5. 构建本地安装包

本地测试推荐关闭 updater artifacts：

```powershell
npm run tauri:build:local
```

只测 NSIS 安装包时可用：

```powershell
npx tauri build --config src-tauri/tauri.nsis-only.conf.json
```

产物目录：

```text
src-tauri/target/release/bundle/
```

### 6. 本地验收清单

- 安装包能安装并启动，窗口按钮、tab、设置页按钮可点击。
- 代理能启动/停止，`ide-byok-proxy` 不弹出命令行窗口。
- 关闭或退出应用后 sidecar 被清理，重新安装时不会提示 `ide-byok-proxy.exe` 被占用。
- 设置页能显示当前版本，手动检查更新按钮不会导致前端报错。
- 本地测试包不上传公开 Release，不覆盖正式 `latest.json`。
- 如果本地验证 protected sidecar，必须确认代理核心功能、模型映射、供应商请求和日志仍正常。

## 二、云端编译打包并发布更新

云端发布用于正式分发。私有仓库负责编译，公开仓库只接收安装包、`.sig` 签名文件和 `latest.json`。正式分发包应按防篡改发布原则执行，不使用本地临时包替代。

### 1. GitHub Secrets

在私有源码仓库配置：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri updater 私钥内容，对应 `tauri-sign.key.pub`。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；没有密码时留空或按实际 CI 配置处理。
- `RELEASE_REPO_TOKEN`：有公开分发仓库 `contents: write` 权限的 token。

私钥文件 `tauri-sign.key` 必须只保存在本地或 Secret 中，不能提交到任何仓库。

发版前可用以下命令确认 Secret 是否存在：

```powershell
gh secret list --repo soulvon/IDE-BYOK
```

如果 `TAURI_SIGNING_PRIVATE_KEY` 缺失，可从本地私钥文件写入。不要把私钥内容打印到终端或提交到仓库：

```powershell
Get-Content -Raw tauri-sign.key | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo soulvon/IDE-BYOK
```

无密码私钥也建议显式配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为空字符串，避免 CI 进入交互式密码等待。

### 2. 发版前检查

- 私有仓库保持 private。
- 公开仓库 `soulvon/IDE-BYOK-Release` 可访问，并且只用于 Release 资产。
- 公开仓库必须至少有一个默认分支提交，例如只包含 README 的 `main` 分支；空仓库无法把 Release 标记为 latest。
- `src-tauri/tauri.conf.json` 的 updater endpoint 指向公开仓库。
- 三处版本号一致，且 tag 使用同一版本：例如 `v1.2.6`。
- `CHANGELOG.md` 已写入本版本更新内容。
- CI 矩阵至少覆盖 Windows x64、macOS arm64、macOS x64、Linux x64。
- `scripts/release/build_merged_latest_json.cjs` 能识别当前 Tauri 产物命名，包括 Windows `.exe`/`.msi`、macOS `.app.tar.gz`、Linux `.AppImage`/`.deb` 及对应 `.sig`。

### 3. 触发云端发布

提交版本变更后打 tag：

```powershell
git tag v1.2.6
git push origin v1.2.6
```

也可以在 GitHub Actions 手动运行 `Release` workflow，但正式发布建议使用 tag 触发。

### 4. CI 工作流结果

私有仓库 `.github/workflows/release.yml` 会执行：

- `prepare-release` 单独创建私有仓库 draft release，并把 `releaseId` 传给后续矩阵任务。
- 在各平台 runner 上安装依赖。
- 按平台构建 sidecar，并放入 `src-tauri/binaries`。
- 正式 release 标准为 protected sidecar；如果 CI 仍使用普通 `pkg` 构建，则该版本只视为普通发布包，不视为防篡改发布包。
- 各平台用同一个 `releaseId` 执行 Tauri build，生成安装包和 updater 签名资产，并上传到同一个私有 draft release。
- 下载私有仓库 release assets。
- 生成合并后的 `latest.json`。
- 上传安装包、`.sig` 和 `latest.json` 到公开分发仓库。
- 发布公开仓库的 Release，并标记为 latest。

不要让四个平台并发各自“找不到 release 就创建 draft release”。这会导致同一个 tag 下出现多个 draft，资产被分散，后续 `latest.json` 只拿到一部分平台。

### 5. 正式发布保护验收

- Release workflow 不直接公开源码或构建中间目录。
- sidecar 使用 protected 构建产物，不直接发布普通 `pkg proxy-entry.js` 产物。
- Tauri updater artifacts 已签名，公开 `latest.json` 中每个平台都有对应 signature。
- 公开仓库不包含 `tauri-sign.key`、GitHub token、代码签名证书、私有源码压缩包。
- 后续启用完整性清单后，正式包启动时应显示官方构建验证通过；篡改关键文件后应显示非官方或拒绝运行代理。

### 6. 公开仓库验收

公开仓库 Release 必须至少包含：

- Windows：NSIS `.exe` 或 MSI `.msi` 安装包，以及对应 `.sig` 资产。
- macOS：Apple Silicon 和 Intel 的 `.app.tar.gz` updater 资产及 `.sig`。
- Linux：AppImage 或 deb 资产及 `.sig`。
- `latest.json`。

打开公开仓库的：

```text
https://github.com/soulvon/IDE-BYOK-Release/releases/latest/download/latest.json
```

确认 `version` 是当前版本，`platforms` 中包含目标平台 key。

当前正式发布至少应包含这些 updater 平台 key：

```text
windows-x86_64
windows-x86_64-nsis
windows-x86_64-msi
darwin-aarch64
darwin-aarch64-app
darwin-x86_64
darwin-x86_64-app
linux-x86_64
linux-x86_64-appimage
linux-x86_64-deb
```

如果 `latest.json` 只包含 macOS，通常是合并脚本仍按旧的 `.zip` / `.tar.gz` 规则匹配 Windows 或 Linux 资产，需要更新资产匹配正则并重新上传 `latest.json`。

### 7. 用户端更新验收

使用旧版本安装包启动应用后：

- 自动检查或手动检查能发现新版本。
- 开启提醒时出现“发现新版本”窗口。
- 立即更新能下载并安装；失败时显示错误和“前往下载页”兜底按钮。
- 开启后台自动更新时，检测到新版本后静默下载并等待重启生效。
- 更新后首次启动必须出现“更新成功！”窗口，显示“已从 v旧版本 更新到 v新版本”，并展示更新内容。
- 关闭“更新成功！”窗口后，再继续执行一次自动更新检查。

### 8. v1.2.10 云端打包复盘

本次正式云端打包验证了完整链路，留下以下固定经验：

- 本地 `npm run tauri:build:local` 成功不代表云端正式包能成功；正式包还需要 updater 私钥签名。
- `TAURI_SIGNING_PRIVATE_KEY` 缺失时，四个平台会在安装包生成后签名失败，浪费十几分钟。workflow 应在早期显式校验该 Secret。
- `tauri-apps/tauri-action@v0` 不支持 `releaseBodyPath` 输入。需要先用脚本提取 changelog，再用 action 支持的输入，或由前置 job 创建 release notes。
- 四个平台矩阵并发时，不能让每个 job 自己创建 draft release。必须先由 `prepare-release` 创建一个 source draft release，再把 `releaseId` 传给矩阵 job。
- 公开分发仓库不能是空仓库。至少初始化一个 README 到 `main` 分支，否则 `gh release edit --latest` 会报 `Repository is empty`。
- `latest.json` 必须从公开仓库实际资产命名生成。Tauri v2 当前 Windows/Linux updater 资产可能是直接的 `.exe`、`.msi`、`.AppImage`、`.deb` 加 `.sig`，不一定是 `.zip` 或 `.tar.gz`。
- 如果发版失败留下 draft release，先删除私有仓库和公开仓库的错误 draft，再重跑 workflow；不要发布缺平台资产。

## 三、版本发布规则

- 每个正式版本必须递增版本号，不复用 tag。
- 不在公开仓库上传源码压缩包；公开仓库只做二进制分发。
- `latest.json` 只能指向公开仓库 Release 里的资产。
- 发布失败时先删除公开仓库错误 Release 或重新上传正确资产，再重新生成 `latest.json`。
- 如果某个平台构建失败，不要把缺平台的 `latest.json` 发布为 latest。
- 如果本版本目标是防篡改发布，必须确认 protected sidecar 和签名校验链路已经生效后再标记 latest。

## 四、不影响开发的约束

- `npm run start`、`npm run dev`、`npx tauri dev` 不启用 protected sidecar 强制要求。
- Rust 完整性校验只应在 release 构建启用，debug/dev 模式跳过或只打印提示。
- 防提取、防篡改、代码签名都放在 release workflow，不阻塞日常保存、刷新、调试。
- 本地打包测试可以继续用 `tauri.local.conf.json` 关闭 updater artifacts。
- 如果保护措施导致功能回归，先回退保护流程，不改动代理业务逻辑。

## 五、常见问题

### 本地打包报缺少私钥

本地测试使用 `npm run tauri:build:local`，它会关闭 updater artifacts。正式签名包交给云端 CI。

### 云端打包报 `failed to decode secret key`

优先检查私有仓库是否配置了 `TAURI_SIGNING_PRIVATE_KEY`。如果日志里环境变量为空，说明 Secret 没有写入或写入了错误仓库。无密码私钥也要配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为空字符串，避免非交互环境等待输入。

### `tauri-action` 提示 `Unexpected input releaseBodyPath`

当前使用的 `tauri-apps/tauri-action@v0` 不支持 `releaseBodyPath`。不要直接传文件路径；应在 workflow 中先创建 draft release 或把 changelog 内容转换成 action 支持的 `releaseBody`。

### 同一个 tag 下出现多个 draft release

这是矩阵 job 并发创建 release 导致的。修复方式是增加单独的 `prepare-release` job，只创建一次 source draft release，并把 `releaseId` 传给每个 `tauri-action` 构建 job。

失败后清理重复 draft release：

```powershell
gh api repos/soulvon/IDE-BYOK/releases --jq '.[] | select(.tag_name=="v版本号" and .draft==true) | .id'
gh api -X DELETE repos/soulvon/IDE-BYOK/releases/RELEASE_ID
```

公开仓库如果也已经生成错误 draft，同样删除后再重跑。

### 公开仓库发布时报 `Repository is empty`

公开仓库不能完全为空。初始化一个最小 README 到 `main` 分支即可，不要上传源码：

```powershell
git init -b main
git config user.name "IDE BYOK Release Bot"
git config user.email "release-bot@users.noreply.github.com"
Set-Content -Path README.md -Value "# IDE BYOK Release`n`nBinary release assets only. Source code remains private.`n"
git add README.md
git commit -m "Initialize release repository"
git remote add origin https://github.com/soulvon/IDE-BYOK-Release
git push origin main
```

### `latest.json` 缺少 Windows 或 Linux

先下载公开 release 的 `latest.json`，确认 `platforms` 是否包含 Windows、macOS、Linux。若只包含部分平台，多半是 `scripts/release/build_merged_latest_json.cjs` 的资产命名匹配过窄。修复匹配规则后，重新生成并覆盖上传 `latest.json`，不必重打安装包。

### 安装时报 sidecar 被占用

关闭 IDE BYOK 和代理进程后重试。应用启动和退出路径已经会清理 sidecar，但测试旧包升级时仍要留意残留进程。

### 公开仓库会不会泄露源码

不会。公开仓库只接收编译产物和 `latest.json`。不要把私有源码推送到公开仓库，也不要把私有仓库的源码压缩包手动上传到公开 Release。

### protected sidecar 会影响开发速度吗

不会影响日常开发。开发时仍然运行原始 JS 或普通 sidecar；protected sidecar 只作为正式 release 的构建步骤。

### protected sidecar 会影响运行性能吗

正常代理请求性能基本不受影响。主要成本在构建阶段，启动阶段可能略有增加，但不应影响使用体验。

### 完整性校验会拖慢启动吗

只校验主程序、sidecar 和关键资源时，通常是几十到几百毫秒级。该校验应仅在 release 启用，debug/dev 模式跳过。

### 更新后没有“更新成功！”窗口

检查 `update_settings.json` 中 `last_run_version` 是否被旧版本正确写入，检查新版本是否保存了 `pending_update_notes.json`。窗口由 `check_version_jump` 在启动时判断版本跃迁后触发。
