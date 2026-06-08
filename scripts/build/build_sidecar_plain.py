#!/usr/bin/env python3
"""
Sidecar 普通构建脚本（无加密）
直接 pkg 打包原始 JS，用于先验证功能
"""

import subprocess
import shutil
import os
import json
import sys
import platform

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIDECAR_DIR = os.path.join(BASE_DIR, "sidecar")
OUT_DIR = os.path.join(BASE_DIR, "src-tauri", "binaries")

def detect_platform():
    system = platform.system().lower()
    machine = platform.machine().lower()
    os_name = "macos" if system == "darwin" else system
    if machine in ("x86_64", "amd64"):
        arch = "x64"
    elif machine in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        arch = machine
    return os_name, arch

def get_pkg_target(os_name, arch):
    os_map = {"windows": "win", "macos": "macos", "linux": "linux"}
    pkg_os = os_map.get(os_name, os_name)
    return f"node22-{pkg_os}-{arch}"

def get_tauri_triple(os_name, arch):
    os_map = {"windows": "pc-windows-msvc", "macos": "apple-darwin", "linux": "unknown-linux-gnu"}
    arch_map = {"x64": "x86_64", "arm64": "aarch64"}
    return f"{arch_map.get(arch, arch)}-{os_map.get(os_name, os_name)}"

def get_sidecar_filename(os_name, tauri_triple):
    base = f"ide-byok-proxy-{tauri_triple}"
    return f"{base}.exe" if os_name == "windows" else base

def main():
    os_name, arch = detect_platform()
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--platform" and i + 1 < len(sys.argv[1:]):
            parts = sys.argv[i + 2].split("-")
            if len(parts) == 2:
                os_name, arch = parts[0], parts[1]

    pkg_target = get_pkg_target(os_name, arch)
    tauri_triple = get_tauri_triple(os_name, arch)
    sidecar_filename = get_sidecar_filename(os_name, tauri_triple)

    print(f"[platform] pkg_target={pkg_target}")
    print(f"[platform] output={sidecar_filename}")

    os.makedirs(OUT_DIR, exist_ok=True)

    # 直接 pkg 打包 sidecar 目录
    cmd = f'npx pkg "{SIDECAR_DIR}" --target {pkg_target} --out-path "{OUT_DIR}"'
    print(f"[exec] {cmd}")
    r = subprocess.run(cmd, shell=True, cwd=SIDECAR_DIR, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[stderr] {r.stderr}")
        raise RuntimeError("pkg failed")

    # pkg 输出名 = package.json 中 name 字段，重命名为 Tauri 期望的
    pkg_name = "ide-byok-sidecar"
    if os_name == "windows":
        old = os.path.join(OUT_DIR, f"{pkg_name}.exe")
    else:
        old = os.path.join(OUT_DIR, pkg_name)

    new = os.path.join(OUT_DIR, sidecar_filename)
    if os.path.exists(old):
        shutil.move(old, new)
        print(f"[out] {new}")
    else:
        # 列出 OUT_DIR 帮助排查
        print(f"[warn] expected {old} not found")
        for f in os.listdir(OUT_DIR):
            print(f"  found: {f}")

    print("[done] Plain sidecar built.")

if __name__ == "__main__":
    main()
