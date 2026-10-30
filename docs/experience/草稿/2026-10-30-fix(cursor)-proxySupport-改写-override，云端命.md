---
编号: 2026-10-30-fix-cursor-proxysupport-override-fallback-c4ad50
标题: "fix(cursor): proxySupport 改写 override，云端命令通道本地短路，fallback 未命中留痕"
日期: 2026-10-30
范围: [anybridge]
严重度: medium
状态: active
证据: enable 后 settings.json 实测自动重写为 override；门控 cursor-proxy-support-override。
可信度: 高（当日实测与单测）
前提: Cursor 遵守 http.proxySupport 的 override 语义（3.15/3.27 实测遵守）。
不适用: 无系统代理的机器（两种取值等效）。
触发: [anybridge]
规则: 接管理应强制请求进 MITM：proxySupport 必须写 override（覆盖系统代理），写入/状态匹配/残留清理三处签名必须同步。
该做:
  - settings.rs 用 MANAGED_PROXY_SUPPORT 常量统一；旧值经 settings_match 不匹配自动重写。
不该做:
  - 不要让用户为了绕开系统代理去关 Clash；不要在多处各自硬编码代理支持的取值。
检查: "advisory"
提交: c4ad50b8cadcb1d55219e2df57cf3705947a6684
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `cursor-core/src/local_app/proxy.rs`
- `cursor-core/src/local_app/settings.rs`

## 现象

系统代理（Clash）存在时 Cursor 的流量可能绕开本地 MITM，自定义模型静默失效且零日志。

（自动采集自提交 `c4ad50b8cadcb1d55219e2df57cf3705947a6684`）。

## 根因

proxySupport 写的是 on（语义为「使用代理设置」），系统代理存在时 Cursor 可能优先走系统代理而不是 http.proxy。

## 修复

见提交 `c4ad50b8cadcb1d55219e2df57cf3705947a6684`。

## 代价

Cursor 的遥测等透传流量也强制经 MITM。

## 复盘

已于当日补齐根因/规则/该做/不该做并转 active。
