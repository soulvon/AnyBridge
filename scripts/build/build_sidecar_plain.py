#!/usr/bin/env python3
"""
Sidecar 普通构建脚本（无加密）
直接 pkg 打包原始 JS，用于先验证功能
"""

import subprocess
import shutil
import os
import json
import platform
import argparse

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SIDECAR_DIR = os.path.join(BASE_DIR, "sidecar")
OUT_DIR = os.path.join(BASE_DIR, "src-tauri", "binaries")
NPX = "npx.cmd" if os.name == "nt" else "npx"

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

def normalize_platform(os_name, arch):
    os_aliases = {
        "win": "windows",
        "win32": "windows",
        "windows": "windows",
        "darwin": "macos",
        "mac": "macos",
        "macos": "macos",
        "linux": "linux",
    }
    arch_aliases = {
        "amd64": "x64",
        "x86_64": "x64",
        "x64": "x64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }
    normalized_os = os_aliases.get(os_name.lower())
    normalized_arch = arch_aliases.get(arch.lower())
    if not normalized_os:
        raise ValueError(f"Unsupported platform OS: {os_name}")
    if not normalized_arch:
        raise ValueError(f"Unsupported platform arch: {arch}")
    return normalized_os, normalized_arch

def parse_platform(value):
    value = value.strip().lower()
    rust_triples = {
        "x86_64-pc-windows-msvc": ("windows", "x64"),
        "aarch64-pc-windows-msvc": ("windows", "arm64"),
        "x86_64-apple-darwin": ("macos", "x64"),
        "aarch64-apple-darwin": ("macos", "arm64"),
        "x86_64-unknown-linux-gnu": ("linux", "x64"),
        "aarch64-unknown-linux-gnu": ("linux", "arm64"),
    }
    if value in rust_triples:
        return rust_triples[value]
    parts = [p for p in value.replace("_", "-").split("-") if p]
    if len(parts) != 2:
        raise ValueError("Expected --platform like windows-x64, macos-arm64, linux-x64, or a Rust target triple")
    return normalize_platform(parts[0], parts[1])

def get_pkg_target(os_name, arch):
    os_map = {"windows": "win", "macos": "macos", "linux": "linux"}
    pkg_os = os_map.get(os_name, os_name)
    return f"node22-{pkg_os}-{arch}"

def get_tauri_triple(os_name, arch):
    os_map = {"windows": "pc-windows-msvc", "macos": "apple-darwin", "linux": "unknown-linux-gnu"}
    arch_map = {"x64": "x86_64", "arm64": "aarch64"}
    return f"{arch_map.get(arch, arch)}-{os_map.get(os_name, os_name)}"

def get_sidecar_filename(os_name, tauri_triple):
    base = f"anybridge-proxy-{tauri_triple}"
    return f"{base}.exe" if os_name == "windows" else base

def get_pkg_name():
    package_path = os.path.join(SIDECAR_DIR, "package.json")
    with open(package_path, "r", encoding="utf-8") as f:
        return json.load(f).get("name", "anybridge-sidecar")

def main():
    parser = argparse.ArgumentParser(description="Build the plain pkg sidecar for Tauri externalBin.")
    parser.add_argument(
        "--platform",
        help="Target platform, e.g. windows-x64, macos-arm64, linux-x64, or x86_64-apple-darwin.",
    )
    args = parser.parse_args()

    os_name, arch = detect_platform()
    if args.platform:
        os_name, arch = parse_platform(args.platform)
    else:
        os_name, arch = normalize_platform(os_name, arch)

    pkg_target = get_pkg_target(os_name, arch)
    tauri_triple = get_tauri_triple(os_name, arch)
    sidecar_filename = get_sidecar_filename(os_name, tauri_triple)

    print(f"[platform] pkg_target={pkg_target}")
    print(f"[platform] output={sidecar_filename}")

    os.makedirs(OUT_DIR, exist_ok=True)

    # 直接 pkg 打包 sidecar 目录
    cmd = [NPX, "pkg", SIDECAR_DIR, "--target", pkg_target, "--out-path", OUT_DIR]
    print(f"[exec] {' '.join(cmd)}")
    r = subprocess.run(cmd, cwd=SIDECAR_DIR, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[stderr] {r.stderr}")
        raise RuntimeError("pkg failed")

    # pkg 输出名 = package.json 中 name 字段，重命名为 Tauri 期望的
    pkg_name = get_pkg_name()
    if os_name == "windows":
        old = os.path.join(OUT_DIR, f"{pkg_name}.exe")
    else:
        old = os.path.join(OUT_DIR, pkg_name)

    new = os.path.join(OUT_DIR, sidecar_filename)
    if os.path.exists(old):
        if os.path.exists(new):
            os.remove(new)
        shutil.move(old, new)
        if os_name != "windows":
            os.chmod(new, 0o755)
        print(f"[out] {new}")
    else:
        # 列出 OUT_DIR 帮助排查
        print(f"[error] expected {old} not found")
        for f in os.listdir(OUT_DIR):
            print(f"  found: {f}")
        raise RuntimeError(f"pkg output missing: expected {old}")

    if not os.path.isfile(new) or os.path.getsize(new) == 0:
        raise RuntimeError(f"sidecar output invalid or empty: {new}")

    print("[done] Plain sidecar built.")

if __name__ == "__main__":
    main()
