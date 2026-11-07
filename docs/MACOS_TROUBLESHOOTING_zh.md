# macOS 常见问题与排查

[English](MACOS_TROUBLESHOOTING.md) • [简体中文](MACOS_TROUBLESHOOTING_zh.md)

> 问题环境记录：macOS 27，Devin 3.10.35。
> 此版本信息描述本次问题现场，不代表其他 macOS 或 Devin 版本已验证。

本文用于排查 AnyBridge 在 macOS 上的网关、证书信任和 TLS 连接问题。系统信任修改会影响设备安全设置；先收集诊断信息，再确认具体证书与操作范围，不要反复轮换 CA。

## 先区分症状

| 症状                                          | 可能范围                                                            | 首要检查                                                            |
| --------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| IDE 报`TLS alert bad certificate`、alert 42 | 客户端拒绝网关呈现的证书；可能涉及信任、有效期、SAN、链或客户端策略 | 网关实际使用的叶子证书、CA 链和系统信任评估                         |
| 出现`no user interaction was possible`      | macOS 无法在当前执行上下文完成信任设置授权                          | 是否处于本地登录的图形桌面会话、是否有授权窗口、设备是否受 MDM 管理 |
| 状态显示已安装，但 TLS 仍失败                 | 证书存在不等于 SSL 策略信任成功；IDE 进程也可能尚未重新加载         | 系统 SSL 验证结果、网关运行证书指纹、完全退出并重开 IDE 后的请求    |
| 重装后仍失败或错误反复出现                    | 网关内存中的旧证书、磁盘新证书或系统信任可能不一致                  | 停止网关，核对证书目录与 CA/叶子指纹；避免再次盲目轮换              |

部分遥测请求成功、网关端口可连接或体检没有明显错误，都不能单独证明 IDE 的模型请求 TLS 正常。

## 安全恢复流程

1. 记录 macOS 版本、AnyBridge 版本、IDE/CLI 版本、完整错误和诊断报告。分享日志前删除 API key、Cookie、访问令牌及其他敏感数据。
2. 保存工作，停止 AnyBridge 管理的网关，并完全退出目标 IDE。不要在网关仍运行时轮换证书，也不要连续点击“清理并重装”。
3. 从 AnyBridge 环境检测报告确认实际 `cert_file` 路径。默认位置通常是 `~/Library/Application Support/anybridge/certs`；旧版迁移、开发模式或环境变量可能改变实际路径，不要假设默认目录就是正在使用的目录。
4. 先检查现有证书。证书有效时优先修复信任，不要仅因 TLS 错误就生成新 CA。确认公开 CA 文件为 `server.codeium.com.pem`；不要导入任何 `*-key.pem` 私钥，也不要把 `mitm-leaf.pem` 设置为信任根。
5. 如果错误明确为无法交互授权，在本地登录的图形桌面会话中使用“钥匙串访问”检查并按组织策略完成授权。核对证书指纹及目标信任域；系统级信任会影响整台设备。若设备由 MDM/组织策略管理，或授权被禁止，停止并联系管理员，不要尝试绕过策略。
6. 使用下方只读命令检查证书材料与系统 SSL 策略。若命令参数与当前 macOS 版本不符，先运行 `security help verify-cert` 查看本机帮助，不要尝试用修改信任的命令代替诊断。
7. 确认信任状态后，再启动 AnyBridge 网关和 IDE。新进程应重新读取当前证书。用一次真实 IDE 模型请求验证握手、预期本地路由和响应；同时检查日志中 TLS 拒绝是否停止出现。

## 只读诊断命令

先将 `CERT_DIR` 设置为第 3 步确认的证书目录。以下命令只读取证书并执行验证，不安装、删除或修改钥匙串信任：

```sh
CERT_DIR="$HOME/Library/Application Support/anybridge/certs"

openssl x509 -in "$CERT_DIR/server.codeium.com.pem" \
  -noout -subject -issuer -dates -fingerprint -sha256
openssl x509 -in "$CERT_DIR/mitm-leaf.pem" \
  -noout -subject -issuer -dates -fingerprint -sha256
openssl verify -CAfile "$CERT_DIR/server.codeium.com.pem" \
  "$CERT_DIR/mitm-leaf.pem"
/usr/bin/security verify-cert -c "$CERT_DIR/mitm-leaf.pem" \
  -p ssl -s server.codeium.com
```

解释结果时注意：

- `openssl verify -CAfile` 只验证显式提供的根证书下的链，不代表 macOS 系统信任或 IDE 已信任。
- `security verify-cert` 用于补充 macOS SSL 策略评估；证书链读取和参数行为以目标机器的 `security help verify-cert` 为准。
- CA 指纹与叶子证书指纹不同。比较运行中网关与磁盘证书时，应比较叶子对叶子，不能把 CA 指纹当作叶子指纹。
- 任一命令通过都不能代替从目标 IDE 发出的真实 TLS 请求。

## 首次接入与重试

首次使用时按 AnyBridge 界面提示先生成完整证书材料，再完成显式信任安装。若授权被取消或交互不可用：

- 以失败处理，不要将“证书文件已生成”理解为“系统信任已安装”。
- 保存原始授权错误和证书指纹，确认网关停止后再决定后续操作。
- 重新尝试前先确认处于可交互的本地桌面会话；不要通过后台任务、SSH 会话或隐藏进程反复请求授权。
- 不要自动删除旧信任根、关闭 SIP、修改 authorization database，或要求用户关闭 TLS 校验。

## 必须避免

- 不设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不关闭 IDE/客户端 SSL 校验。
- 不把 CA 私钥、叶子私钥或完整诊断目录上传到 issue、聊天或仓库。
- 不把 AnyBridge CA 全局注入所有进程，或通过全局网关/证书环境变量扩大影响范围。
- 不因一次 TLS 错误就清理钥匙串或轮换 CA。信任根的添加和删除都需要明确确认；企业设备遵循管理员/MDM 策略。

## 何时升级处理

提供以下已脱敏信息给维护者或设备管理员：macOS 与 AnyBridge/IDE 版本、错误原文和发生时间、实际证书目录、CA 与叶子 SHA-256 指纹、只读验证的退出状态，以及网关停止/重启后真实 IDE 请求是否改变。不要附带私钥或供应商凭据。

开发者构建依赖和 macOS 打包说明见 [开发指南](DEVELOPMENT_zh.md) 与 [发行指南](RELEASE_zh.md)。历史事故证据和本项目修复实施状态保留在仓库根目录的 `修复mac环境异常方案.md`。
