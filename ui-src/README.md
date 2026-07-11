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
    pages/                   # 各业务页（按 PAGE 注释切分）
    body-tail.html           # </main> 之后：全局弹窗 + script 标签
  manifest.json              # 切片元数据（只读参考）
```

## Include

```html
<!-- @include partials/pages/settings.html -->
```

路径相对 `ui-src/`。构建脚本：`scripts/build-ui.mjs`。

## 注意

- 不要手改 `ui/index.html`（产物）。
- `page-extensions` 目前仍在 `eval-history.html` 片段内（与拆分前 DOM 顺序一致）；后续可再拆。
- 弹窗可逐步从 `body-tail.html` 挪到 `partials/modals/`，只要保持 include 顺序即可。
