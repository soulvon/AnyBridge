# ui-src — HTML 源码

本目录是前端 **HTML 唯一源码**。修改后请执行：

```bash
npm run build:ui
npm run check:ui
```

## 结构

```
ui-src/
  index.html                 # 壳：head、顶栏、侧栏、<main>、@include
  partials/
    pages/                   # 各业务页
    modals/                  # 全局弹窗
    scripts-app.html         # classic script 标签顺序（含 05-actions.js）
    scripts-i18n.html
    shell-close.html
  manifest.json              # 切片元数据（只读参考）
```

## Include

```html
<!-- @include partials/pages/settings.html -->
```

路径相对 `ui-src/`。构建脚本：`scripts/build-ui.mjs`。

## 事件

- **禁止**在 HTML 中写 `onclick` / `onchange` 等内联事件。
- 使用 `data-action` / `data-args` / `data-events` 等，由 `ui/assets/scripts/05-actions.js` 统一委托。
- 约定详见 `ui/README.md` 的「事件约定」一节。

## 注意

- 不要手改 `ui/index.html`（产物）。
- 弹窗放在 `partials/modals/`，在壳或 body 尾部按顺序 `@include`。
- 新增 script 文件时同步改 `partials/scripts-app.html` 与 `scripts/check-ui.mjs` 的顺序清单。
