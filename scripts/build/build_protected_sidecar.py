#!/usr/bin/env python3
"""
Sidecar 保护构建脚本 (bytenode + pkg)
流程: 复制源码 → bytenode 编译为 V8 字节码 → 自定义 loader → pkg 打包
支持 Windows / macOS / Linux 多平台构建
跳过 javascript-obfuscator 混淆，大幅加速构建（~30秒）
"""

import subprocess
import shutil
import os
import json
import glob
import sys
import platform

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SIDECAR_DIR = os.path.join(BASE_DIR, "sidecar")
BUILD_DIR = os.path.join(BASE_DIR, "sidecar-build")
JSC_DIR = os.path.join(BUILD_DIR, "jsc")
OUT_DIR = os.path.join(BASE_DIR, "src-tauri", "binaries")

# ─── 平台配置 ────────────────────────────────────────────────

def detect_platform():
    """检测当前平台，返回 (os, arch)"""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "darwin":
        os_name = "macos"
    else:
        os_name = system

    if machine in ("x86_64", "amd64"):
        arch = "x64"
    elif machine in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        arch = machine

    return os_name, arch

def get_pkg_target(os_name, arch):
    """返回 pkg 的 target triple"""
    node_version = "22"
    os_map = {"windows": "win", "macos": "macos", "linux": "linux"}
    arch_map = {"x64": "x64", "arm64": "arm64"}
    pkg_os = os_map.get(os_name, os_name)
    pkg_arch = arch_map.get(arch, arch)
    return f"node{node_version}-{pkg_os}-{pkg_arch}"

def get_tauri_triple(os_name, arch):
    """返回 Tauri 期望的 sidecar 文件名中的 target triple"""
    os_map = {"windows": "pc-windows-msvc", "macos": "apple-darwin", "linux": "unknown-linux-gnu"}
    arch_map = {"x64": "x86_64", "arm64": "aarch64"}
    tauri_arch = arch_map.get(arch, arch)
    tauri_os = os_map.get(os_name, os_name)
    return f"{tauri_arch}-{tauri_os}"

def get_sidecar_filename(os_name, tauri_triple):
    """返回 Tauri binaries/ 目录下期望的 sidecar 文件名"""
    base = f"ide-byok-proxy-{tauri_triple}"
    if os_name == "windows":
        return f"{base}.exe"
    return base

# ─── 构建步骤 ────────────────────────────────────────────────

def run(cmd, cwd=None):
    print(f"[exec] {cmd}")
    r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[stderr] {r.stderr}")
        raise RuntimeError(f"Command failed: {cmd}")
    return r

def clean():
    if os.path.exists(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(JSC_DIR, exist_ok=True)

def copy_source():
    """复制 sidecar 源码到构建目录"""
    # 复制全部文件（排除 node_modules 中 .bin 等，保留 bytenode）
    for item in os.listdir(SIDECAR_DIR):
        src = os.path.join(SIDECAR_DIR, item)
        dst = os.path.join(JSC_DIR, item)
        if item == "node_modules":
            # 只复制 bytenode，pkg 运行时不需要其他 node_modules
            bn_src = os.path.join(src, "bytenode")
            if os.path.exists(bn_src):
                shutil.copytree(bn_src, os.path.join(dst, "bytenode"))
            continue
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

def bytenode_compile():
    """将 JS 编译成 V8 bytecode (.jsc)，删除原始 .js"""
    # 需要编译的入口和模块文件
    entries = ["hybrid-server.js", "inference-proxy.js", "proxy-entry.js"]
    modules = [
        "connect.js", "mitm-logger.js", "port-utils.js",
        "proto.js", "provider-pool.js", "rename-models.js",
        "stats.js", "inject-models.js", "load-env.js"
    ]
    handlers = glob.glob(os.path.join(JSC_DIR, "handlers", "*.js"))

    all_js = []
    for f in entries + modules:
        p = os.path.join(JSC_DIR, f)
        if os.path.exists(p):
            all_js.append(p)
    all_js.extend(handlers)

    for src in all_js:
        jsc_path = src.replace('.js', '.jsc')
        run(f'npx bytenode --compile "{src}" -o "{jsc_path}"')
        rel = os.path.relpath(src, JSC_DIR)
        print(f"[jsc] {rel} -> .jsc")
        # 编译成功后删除原始 .js
        os.remove(src)

def create_loader():
    """创建自定义 loader：加载 .jsc 字节码"""
    loader_js = os.path.join(JSC_DIR, "__loader.js")
    with open(loader_js, "w", encoding="utf-8") as f:
        f.write(r'''// BYOK Protected Sidecar Loader — V8 Bytecode
const bytenode = require('bytenode');
const path = require('path');

const ENTRY_MAP = {
  'hybrid-server': './hybrid-server.jsc',
  'inference-proxy': './inference-proxy.jsc',
  'proxy-entry': './proxy-entry.jsc',
};

const target = process.argv[2] || 'proxy-entry';
const entry = ENTRY_MAP[target];
if (!entry) {
  console.error('Unknown entry:', target);
  process.exit(1);
}

require(path.resolve(__dirname, entry));
''')

def pkg_bundle(os_name, arch):
    """用 pkg 打包最终二进制"""
    os.makedirs(OUT_DIR, exist_ok=True)

    pkg_target = get_pkg_target(os_name, arch)
    tauri_triple = get_tauri_triple(os_name, arch)
    sidecar_filename = get_sidecar_filename(os_name, tauri_triple)

    # 修改 package.json 指向 loader
    pkg_json = os.path.join(JSC_DIR, "package.json")
    with open(pkg_json, "r", encoding="utf-8") as f:
        pkg = json.load(f)
    pkg["bin"] = "__loader.js"
    pkg["pkg"] = {
        "assets": [
            "**/*.jsc",
            "node_modules/bytenode/**/*",
            "prompts/**/*",
            "certs/**/*",
            "handlers/**/*.jsc"
        ],
        "targets": [pkg_target]
    }
    with open(pkg_json, "w", encoding="utf-8") as f:
        json.dump(pkg, f, indent=2)

    run(f'npx pkg "{JSC_DIR}" --out-path "{OUT_DIR}"', cwd=JSC_DIR)

    # 重命名为 Tauri 期望的名称
    if os_name == "windows":
        old_name = "__loader.exe"
    else:
        old_name = "__loader"

    old = os.path.join(OUT_DIR, old_name)
    new = os.path.join(OUT_DIR, sidecar_filename)
    if os.path.exists(old):
        shutil.move(old, new)
        print(f"[out] {new}")
    else:
        print(f"[warn] pkg output not found: {old}")
        for f in os.listdir(OUT_DIR):
            print(f"  found: {f}")

def main():
    # 解析 --platform 参数
    os_name, arch = detect_platform()
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--platform" and i + 1 < len(sys.argv[1:]):
            platform_str = sys.argv[i + 2]
            parts = platform_str.split("-")
            if len(parts) == 2:
                os_name, arch = parts[0], parts[1]

    print(f"[platform] os={os_name}, arch={arch}")
    print(f"[platform] pkg_target={get_pkg_target(os_name, arch)}")
    print(f"[platform] tauri_triple={get_tauri_triple(os_name, arch)}")
    print(f"[platform] sidecar_filename={get_sidecar_filename(os_name, get_tauri_triple(os_name, arch))}")

    clean()
    copy_source()
    bytenode_compile()
    create_loader()
    pkg_bundle(os_name, arch)
    print("\n[done] Protected sidecar built successfully.")

if __name__ == "__main__":
    main()
