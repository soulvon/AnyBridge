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
  },
};

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
console.log(`[install-codebuddy-hook] 已写入 ${file}`);
