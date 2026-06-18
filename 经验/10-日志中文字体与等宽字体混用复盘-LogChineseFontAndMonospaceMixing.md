# 日志中文字体与等宽字体混用复盘

> 项目：AnyBridge | 时间：2026-06-16

---

## 一、问题现象

平台总览页的“最近活动”和“平台日志”里，中文日志显示明显发硬、发窄，和 cockpit-tools 的界面字体观感差距很大。

典型表现：

| 区域 | 表现 |
|------|------|
| 日志正文 | 中文像被压进等宽字体，阅读感差 |
| 英文/状态 | `INFO`、`WARN`、时间戳对齐正常 |
| 全局字体调整后 | 页面其它文字变好，但日志中文仍然别扭 |

这说明问题不只在全局 `--font-body`，还在日志组件自己的字体规则。

---

## 二、根因分析

### 2.1 `.log-body` 整块使用等宽字体

日志样式原先这样写：

```css
.log-body {
  font-family: var(--font-mono);
}
```

这会让整行日志都进入等宽字体环境，包括中文正文。

等宽字体适合：

- 时间戳
- 日志级别
- 短 ID
- Token / URL / 模型名
- 需要列对齐的机器信息

但不适合大段中文自然语言。中文被放进 mono fallback 后，会出现字形窄、灰度不均、笔画偏硬的问题。

### 2.2 中英文混排不能只看全局字体

即使全局已经对齐 cockpit-tools：

```css
--font-body: 'Inter', 'Segoe UI', sans-serif;
--font-mono: 'JetBrains Mono', 'SFMono-Regular', monospace;
```

局部组件如果显式写了 `font-family: var(--font-mono)`，仍然会覆盖全局字体。

排查字体问题时不能只查 `body` 的 computed style，还要查目标元素，例如：

- `.log-body`
- `.log-line`
- `.log-ts`
- `.log-lv`
- `.log-msg`

### 2.3 日志行是混合语义，不应共用一个字体

一行日志包含三类信息：

```html
<span class="log-ts">04:53:03</span>
<span class="log-lv warn">WARN</span>
<span class="log-msg">检测模型完整列表拉取失败...</span>
```

正确做法是分层：

| 元素 | 字体策略 |
|------|----------|
| `.log-ts` | 等宽，保证时间列齐 |
| `.log-lv` | 等宽，保证级别列齐 |
| `.log-msg` | sans 中文友好字体，保证正文可读 |

---

## 三、修复方案

### 3.1 保留日志容器的等宽基调

`.log-body` 可以继续保持等宽默认值，因为时间戳和级别是日志的结构骨架：

```css
.log-body {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.8;
}
```

### 3.2 单独覆盖日志正文 `.log-msg`

给日志正文使用中文友好的 sans 字体栈：

```css
.log-msg {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--text-secondary);
  font-family: 'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
```

关键点：

| 属性 | 作用 |
|------|------|
| `font-family` | 中文正文脱离等宽字体 |
| `font-weight: 500` | 比 400 更清楚，比 700 更不硬 |
| `line-height: 1.75` | 适合中文日志阅读 |
| `min-width: 0` | 允许 flex 子项收缩 |
| `overflow-wrap: anywhere` | 长 URL / 错误信息不会撑破卡片 |

### 3.3 日志行顶部对齐

多行日志换行时，时间戳和级别应停在第一行顶部：

```css
.log-line {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
```

---

## 四、验证方法

### 4.1 视觉验证

重点看这两处：

1. 平台总览页右下角“最近活动”。
2. 平台日志页完整日志列表。

期望结果：

- 时间戳仍然上下对齐。
- `INFO` / `WARN` 仍然整齐。
- 中文正文不再像等宽字体，阅读更接近 cockpit-tools。
- 长错误信息换行后不撑破卡片。

### 4.2 computed style 验证

在浏览器里检查：

```js
getComputedStyle(document.querySelector('.log-msg')).fontFamily
```

应包含：

```text
Inter, Microsoft YaHei UI, Microsoft YaHei, PingFang SC, sans-serif
```

同时检查：

```js
getComputedStyle(document.querySelector('.log-ts')).fontFamily
getComputedStyle(document.querySelector('.log-lv')).fontFamily
```

它们仍可继承 `.log-body` 的 `var(--font-mono)`。

### 4.3 自动检查

修改后执行：

```bash
npm run check:ui
```

本次修复已通过：

```text
UI check passed (10 scripts, 6 styles).
```

---

## 五、经验总结

### 5.1 不要用 mono 包整块 UI 文本

等宽字体只能用于结构化字段，不要直接包住包含中文自然语言的大容器。

推荐：

```css
.row-meta { font-family: var(--font-mono); }
.row-message { font-family: var(--font-body); }
```

避免：

```css
.log-panel { font-family: var(--font-mono); }
```

### 5.2 修字体问题要先定位目标元素

字体问题不能只看全局变量。排查顺序：

1. 目标文字对应的 DOM 元素是什么。
2. 它自己有没有 `font-family`。
3. 父级有没有强制 `font-family`。
4. 是否有局部组件 CSS 覆盖全局 token。
5. computed style 最终吃到的字体是什么。

### 5.3 对比参考项目时要分清“全局字体”和“组件字体”

cockpit-tools 的全局字体经验可以迁移：

```css
--font-sans: 'Inter', 'Segoe UI', sans-serif;
--font-mono: 'JetBrains Mono', 'SFMono-Regular', monospace;
```

但最终观感还取决于组件里有没有：

- `font-weight: 800/900`
- `font-family: var(--font-mono)`
- `line-height: 1`
- 局部硬编码字体

如果只改全局变量，局部问题仍然会存在。

### 5.4 中英文混排的实用字体栈

日志正文建议使用：

```css
font-family: 'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
```

原因：

- 英文优先使用 Inter，保持 cockpit-tools 风格。
- Windows 中文优先使用 Microsoft YaHei UI / Microsoft YaHei。
- macOS 中文可回退到 PingFang SC。
- 不依赖网络字体，适合 Tauri / 本地应用。

---

## 六、后续注意

如果以后继续统一字体，优先处理这些高影响区域：

1. 日志正文、错误提示、toast、诊断报告：中文可读性优先，不要整块 mono。
2. 侧栏、导航、按钮：字重控制在 500-700，避免 800/900 伪粗体。
3. 表格 ID、时间、模型名、Token 数字：保留 mono。
4. 大段说明文案：使用 `var(--font-body)`，line-height 建议不低于 1.55。

一句话原则：

```text
机器字段用 mono，给人读的中文用 sans。
```
