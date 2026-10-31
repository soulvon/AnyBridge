#!/usr/bin/env node
/**
 * 重建 AnyBridge 的 CodeBuddy PreToolUse 配置。
 * .codebuddy/ 被项目 .gitignore 忽略，因此配置不入库，用这个脚本重建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.codebuddy');
const file = path.join(dir, 'settings.json');

// 外部经验库指针：只有本机设了 DEVELOP_LOOP_ROOT 才写入生成的规则。
// 不写死盘符，避免把某台机器的目录结构带进公开仓库。
const devloopRoot = process.env.DEVELOP_LOOP_ROOT || '';
const devloopPointer = devloopRoot
  ? `- 外部经验库：${devloopRoot}/方法/04_前端与交互.md（本机专属，未配置则忽略本行）`
  : '';

const settings = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit|ApplyPatch|write_to_file|replace_file_content|apply_diff|save_file',
        hooks: [
          {
            type: 'command',
            command: 'python scripts/codebuddy_guard.py',
            timeout: 10,
          },
        ],
      },
    ],
    // 上游内容过滤拒答时自动续跑，避免任务清单卡在第一项（2026-10-29 事故）
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: 'python scripts/codebuddy_stop_hook.py',
            timeout: 10,
          },
        ],
      },
    ],
  },
};

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

const rulesDir = path.join(dir, 'rules');
const ruleFile = path.join(rulesDir, '前端规范.mdc');
const frontendRule = `---
description: 前端改动强制检查（每次会话自动加载）
alwaysApply: true
enabled: true
updatedAt: 2026-10-28T00:00:00.000Z
provider:
---

# 前端改动强制检查

改 UI 前先读：
- 通用规范：仓库 docs/WORKFLOW.md 与本次涉及页面的既有样式
- 事故判例：docs/pitfalls.json 中 CSS / UI / 图标相关条目
${devloopPointer}

硬性禁止：
- 全大写英文标签、蓝紫渐变、廉价 glow / 雷达 / 呼吸动效、粗彩条、多层卡片。
- 功能图标用 Emoji；手绘没验证过的 SVG。

布局与状态：
- 字号不低于 12px，点击热区不低于 32px，圆角统一。
- 空态、加载态、错误态不能白屏、塌陷或贴边。
- 改完跑 npm run check:ui；任何视觉改动附改前/改后截图。
`;
fs.mkdirSync(rulesDir, { recursive: true });
fs.writeFileSync(ruleFile, frontendRule, 'utf8');

console.log(`[install-codebuddy-hook] 已写入 ${file}`);
console.log(`[install-codebuddy-hook] 已写入 ${ruleFile}`);
