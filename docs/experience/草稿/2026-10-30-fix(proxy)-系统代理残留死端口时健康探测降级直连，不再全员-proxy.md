---
编号: 2026-10-30-fix-proxy-proxyconnect-5188e2
标题: "fix(proxy): 系统代理残留死端口时健康探测降级直连，不再全员 proxyconnect 拒绝"
日期: 2026-10-30
范围: [anybridge]
严重度: medium
状态: active
证据: system-proxy.test.js 两场景（降级/恢复）通过；本机 FlClash 残留 7897 实测复现与自愈。
可信度: 高（当日实测与单测）
前提: 上游中「可直连」的部分在代理死亡后仍可用；必须走代理的上游在直连下仍会失败（预期行为）。
不适用: 显式配置 ANYBRIDGE_UPSTREAM_PROXY / HTTPS_PROXY 的场景（用户明确要求走代理）。
触发: [anybridge]
规则: 出站走系统代理前必须探测端口连通性（周期+超时），死端口降级直连、恢复自动切回；探测与缓存分层（配置 1s、健康 5s）。
该做:
  - 健康标志由后台探测维护，httpsAgentFor 按标志同步选择代理/直连；降级与恢复打限频日志。
不该做:
  - 不要用异步探测阻塞同步的 agent 获取链；不要在代理不可用时反复重建 agent。
检查: "advisory"
提交: 5188e216f97fa252f856a67e2a65d24c8e99caee
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `sidecar/system-proxy.js`
- `sidecar/system-proxy.test.js`

## 现象

代理软件退出但 ProxyEnable=1 残留指向 127.0.0.1:7897，端口无进程监听；sidecar 上游请求全部 proxyconnect ECONNREFUSED，重启服务前无法自愈。

（自动采集自提交 `5188e216f97fa252f856a67e2a65d24c8e99caee`）。

## 根因

「重读系统代理配置」解决不了「配置有效但端口死了」——重读一万次读到的还是死地址；缺少端口连通性探测与降级路径。

## 修复

见提交 `5188e216f97fa252f856a67e2a65d24c8e99caee`。

## 代价

每 5 秒一次本地 TCP 探测（毫秒级）。

## 复盘

已于当日补齐根因/规则/该做/不该做并转 active。
