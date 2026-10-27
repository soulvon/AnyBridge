#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AnyBridge CodeBuddy PreToolUse 写入守卫。

只做路径安全，不跑测试：
- 禁止写到仓库外；
- 禁止写 .git / node_modules / dist / dist-electron / target；
- 禁止在仓库根直接写 .log / .tmp。

协议：stdin 单行 JSON（tool_name/tool_input/cwd）；exit 0 放行，exit 2 熔断。
"""
import json
import os
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        if stream.encoding and stream.encoding.lower() != 'utf-8':
            stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = os.path.normpath(r'E:\project\AnyBridge')
WRITE_TOOLS = {
    'write', 'edit', 'multiedit', 'applypatch', 'apply_patch',
    'write_to_file', 'replace_file_content', 'apply_diff', 'save_file',
}
BLOCKED_TOP = {'.git', 'node_modules', 'dist', 'dist-electron', 'target'}


def deny(message):
    sys.stderr.write(message + '\n')
    sys.exit(2)


def main():
    # Windows 下 Python 默认可能用 cp936 解码 stdin，UTF-8 BOM 会变成乱码。
    # 直接读 bytes，再按 utf-8-sig 解码，兼容 BOM 与中文路径。
    raw = sys.stdin.buffer.read().decode('utf-8-sig', errors='replace').strip()
    if not raw:
        sys.exit(0)
    try:
        data = json.loads(raw)
    except Exception:
        sys.exit(0)

    tool = (data.get('tool_name') or data.get('toolName') or '').lower()
    if tool not in WRITE_TOOLS:
        sys.exit(0)

    tool_input = data.get('tool_input') or data.get('toolInput') or {}
    file_path = tool_input.get('file_path') or tool_input.get('filePath') or ''
    if not file_path:
        sys.exit(0)

    target = os.path.normpath(os.path.abspath(file_path))

    # 只守卫 AnyBridge 自己的文件。项目外的写入交给目标项目自己的门控，
    # 否则从 Ailoop/其他工作区编辑 AnyBridge 时会被误判为越界。
    if target != ROOT and not target.startswith(ROOT + os.sep):
        sys.exit(0)

    rel = os.path.relpath(target, ROOT)
    parts = rel.split(os.sep)
    if parts[0] in BLOCKED_TOP:
        deny(f'【AnyBridge 门控】禁止写生成物/依赖/版本库目录：{rel}')
    if len(parts) >= 2 and parts[0] == 'src-tauri' and parts[1] == 'target':
        deny(f'【AnyBridge 门控】禁止写 Rust 构建目录：{rel}')
    if len(parts) == 1 and (parts[0].lower().endswith('.log') or parts[0].lower().endswith('.tmp')):
        deny(f'【AnyBridge 门控】根目录禁止写日志/临时文件，请进 tmp/<主题>/：{rel}')

    sys.exit(0)


if __name__ == '__main__':
    main()
