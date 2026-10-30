---
编号: 2026-10-30-fix-ui-kicker-d543ac
标题: "fix(ui): 移除日志查看器与引导弹窗残留的英文 kicker 装饰"
日期: 2026-10-30
范围: [anybridge]
严重度: medium
状态: active
证据: check:i18n 通过；ui-src 两处删除。
可信度: 高（当日实测与单测）
前提: 该装饰不承载信息（纯视觉）。
不适用: 承载信息且已翻译的 kicker。
触发: [anybridge]
规则: 纯英文小装饰标签（kicker 类）必须进 keep-en.txt 白名单或删除，不允许裸奔。
该做:
  - 清理时顺带检查其余 partial 的 kicker；新增装饰文案走字典。
不该做:
  - 不要给装饰性英文开白名单口子。
检查: "advisory"
提交: d543ac8634ba68e024d5881aae411c9865f9a72e
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `ui-src/partials/modals/log-viewer-modal.html`
- `ui-src/partials/modals/onboarding-guide-modal.html`

## 现象

日志查看器与引导弹窗残留 log-viewer-kicker / onboarding-guide-kicker 英文装饰标签。

（自动采集自提交 `d543ac8634ba68e024d5881aae411c9865f9a72e`）。

## 根因

i18n 门控建立前的存量英文装饰元素，未随十项门控清理。

## 修复

见提交 `d543ac8634ba68e024d5881aae411c9865f9a72e`。

## 代价

无。

## 复盘

已于当日补齐根因/规则/该做/不该做并转 active。
