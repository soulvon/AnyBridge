---
编号: 2026-10-30-fix-cursor-token-7cff67
标题: "fix(cursor): 免登录注入覆盖新版加密 token，接入链路阶段日志落盘"
日期: 2026-10-30
范围: [anybridge]
严重度: medium
状态: active
证据: Cursor 3.27.22 实测免登录端到端通过（RunSSE 恢复、llm_calls completed）；account 5 单测 + 门控 2 条。
可信度: 高（当日实测与单测）
前提: Cursor 本地 JWT 校验只解码 exp 不验签；扩展宿主 pollForAuthValues 需 creds+token 同时就位。
不适用: 用户主动登录官方账号且未开启本地注入覆盖的场景（已有真实登录值不覆盖）。
触发: [anybridge]
规则: 注入跳过条件必须把「本版本解不开的格式」排除在「已有真实登录」之外；账号注入必须覆盖完整键集（token/email/会员/订阅 7 键）。
该做:
  - 跳过条件排除 SAFE_STORAGE_PREFIX 前缀；注入键集与校验场景用单测锁定（降级自愈/幂等/真登录保留/7 键完整）。
不该做:
  - 不要用「值非空」代替「本版本可用」的判断；不要只写 token 就认为登录态已就绪。
检查: "advisory"
提交: 7cff674107037af26aa5361c17c92539db2ec572
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `cursor-core/src/bin/cursor-server.rs`
- `cursor-core/src/local_app/account.rs`
- `cursor-core/src/local_app/proxy.rs`

## 现象

升级过新版 Cursor（3.27+）的机器上免登录失效：Auth init timeout、agent 请求一次不发、发消息永远转圈（cursor-byok issue #468/#469 同款）。

（自动采集自提交 `7cff674107037af26aa5361c17c92539db2ec572`）。

## 根因

两处叠加：新版登录后把 token 升级成 cursor-safe-storage 加密格式，旧版本解不开；注入跳过条件只判「值非空」，把这种不兼容值误判为已有真实登录而跳过。此外注入只写了 token 两个键，缺会员/订阅状态键时客户端 auth 轮询仍拿不到凭证。

## 修复

见提交 `7cff674107037af26aa5361c17c92539db2ec572`。

## 代价

开启接管后官方账号 token 会被本地 token 覆盖（官方模型需重新登录才可用）。

## 复盘

已于当日补齐根因/规则/该做/不该做并转 active。
