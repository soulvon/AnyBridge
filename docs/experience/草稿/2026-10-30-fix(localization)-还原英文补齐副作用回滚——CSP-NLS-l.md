---
编号: 2026-10-30-fix-localization-csp-nls-locale-5c2988
标题: "fix(localization): 还原英文补齐副作用回滚——CSP/NLS/locale 不再残留"
日期: 2026-10-30
范围: [anybridge]
严重度: medium
状态: active
证据: csp_unsafe_inline_revert_is_exact_inverse 等测试锁定；提交 5c298811。
可信度: 高（当日实测与单测）
前提: 适用于一切「注入可撤销配置」的功能（workbench 注入、代理配置、账号注入）。
不适用: 一次性生成、无需还原的产物。
触发: [anybridge]
规则: 注入类功能的还原必须是「精确逆操作」：插入记入副作用清单，还原按清单逐项撤回；凭记账才允许移除，原厂自带的放行行不能误删。
该做:
  - 插入与还原共用同一份字节序列常量；还原前核对副作用记账。
不该做:
  - 不要在还原路径上重新扫描推断该删什么；不要无条件删除同名内容。
检查: "advisory"
提交: 5c298811bcc7f9c477fdaa707ccddd0f907c1bf6
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `src-tauri/src/commands/app_localization.rs`
- `src-tauri/src/commands/workbench_inject.rs`

## 现象

还原英文补齐后，CSP 的 unsafe-inline、NLS 语言项与 locale 设置残留未恢复。

（自动采集自提交 `5c298811bcc7f9c477fdaa707ccddd0f907c1bf6`）。

## 根因

还原流程只回滚了补齐内容本身，没有处理插入时带来的副作用（CSP 放行行、NLS 项、locale 字段）。

## 修复

见提交 `5c298811bcc7f9c477fdaa707ccddd0f907c1bf6`。

## 代价

插入路径需维护副作用清单。

## 复盘

已于当日补齐根因/规则/该做/不该做并转 active。
