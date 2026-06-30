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
import platform
import argparse

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
    base = f"anybridge-proxy-{tauri_triple}"
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

def local_bin(name):
    """返回 sidecar/node_modules/.bin 下的本地工具路径（Windows 加 .cmd）"""
    ext = ".cmd" if os.name == "nt" else ""
    p = os.path.join(SIDECAR_DIR, "node_modules", ".bin", name + ext)
    if not os.path.exists(p):
        raise FileNotFoundError(f"local bin not found: {p}")
    return p

def find_matching_node(pkg_target_node_major):
    """为 bytenode 找与 pkg target 同主版本的 Node 二进制。

    bytenode 生成的 V8 字节码跟编译时使用的 Node 绑定。如果宿主 Node 主版本
    与 pkg target (如 node22) 不一致，二进制运行时会报
    \"Invalid or incompatible cached data (cachedDataRejected)\"。

    优先顺序：
    1. 环境变量 BYTENODE_NODE_BIN
    2. ~/.pkg-cache/v3.6/fetched-v{VERSION}-win-x64  (与 pkg target Node 同源，最准)
    3. ~/.workbuddy/binaries/node/versions/<{MAJOR}.*>/node.exe  (项目内惯例)
    4. 扫描 PATH 上的 node（仅当主版本匹配）
    """
    env_override = os.environ.get("BYTENODE_NODE_BIN")
    if env_override and os.path.exists(env_override):
        return env_override
    # 与 pkg target Node 同源：~/.pkg-cache/v3.6/fetched-v{VER}-win-x64
    pkg_cache = os.path.join(os.path.expanduser("~"), ".pkg-cache", "v3.6")
    if os.path.isdir(pkg_cache):
        candidates = []
        for entry in os.listdir(pkg_cache):
            # 文件名形如 fetched-v22.22.3-win-x64
            if entry.startswith(f"fetched-v{pkg_target_node_major}.") and "win-x64" in entry \
                    and not entry.endswith(".downloading"):
                p = os.path.join(pkg_cache, entry)
                if os.path.isfile(p):
                    candidates.append(p)
        if candidates:
            return sorted(candidates)[-1]
    # 项目内惯例位置：扫 ~/.workbuddy/binaries/node/versions/ 下 {MAJOR}.* 的子目录
    base = os.path.join(os.path.expanduser("~"), ".workbuddy", "binaries", "node", "versions")
    if os.path.isdir(base):
        candidates = []
        for entry in os.listdir(base):
            stripped = entry.lstrip("v")
            if stripped.startswith(f"{pkg_target_node_major}."):
                p = os.path.join(base, entry, "node.exe")
                if os.path.exists(p):
                    candidates.append(p)
        if candidates:
            return sorted(candidates)[-1]
    # 兜底：扫描 PATH 上 node 的主版本
    import shutil as _shutil
    on_path = _shutil.which("node")
    if on_path:
        try:
            r = subprocess.run([on_path, "--version"], capture_output=True, text=True, timeout=5)
            if r.stdout.strip().startswith(f"v{pkg_target_node_major}."):
                return on_path
        except Exception:
            pass
    return None

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
    """先经 esbuild 把 ESM 转为 CJS，再编译为 V8 bytecode (.jsc)，删除原始 .js。

    bytenode 1.5.x 通过 vm.Script 编译，依赖 CommonJS 语法；sidecar 源码是
    "type":"module" 的 ESM，因此必须先用 esbuild 转 CJS。"""
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

    esbuild_bin = local_bin("esbuild")
    bytenode_cli = os.path.join(SIDECAR_DIR, "node_modules", "bytenode", "lib", "cli.js")
    pkg_target_node_major = int(get_pkg_target("windows", "x64").split("-")[0].replace("node", ""))

    node_bin = find_matching_node(pkg_target_node_major)
    if node_bin is None:
        raise FileNotFoundError(
            f"no Node {pkg_target_node_major}.x binary found. Set BYTENODE_NODE_BIN env var "
            f"to a matching node.exe so bytenode emits V8 bytecode compatible with the "
            f"pkg target node{pkg_target_node_major}-*-*."
        )
    print(f"[bytenode] using {node_bin} (target node{pkg_target_node_major})")

    for src in all_js:
        # 1. esbuild ESM -> CJS（写到临时文件，避免污染原文件再失败回滚）
        cjs_tmp = src[:-3] + ".cjs.tmp.js"
        run(f'"{esbuild_bin}" --log-level=error --format=cjs --platform=node --target=node18 "{src}" --outfile="{cjs_tmp}"')
        # 2. bytenode-compile —— 用与 pkg target 同主版本的 Node，避免 V8 字节码
        #    在运行时被 V8 拒绝。bytenode 不支持 -o，它直接在源旁生成 <src>.jsc。
        cjs_dir = os.path.dirname(cjs_tmp)
        run(f'"{node_bin}" "{bytenode_cli}" --compile "{cjs_tmp}"', cwd=cjs_dir)
        produced_jsc = cjs_tmp[:-3] + ".jsc"  # <src_basename>.cjs.tmp.jsc
        jsc_path = src[:-3] + ".jsc"
        if os.path.exists(produced_jsc):
            shutil.move(produced_jsc, jsc_path)
        rel = os.path.relpath(src, JSC_DIR)
        print(f"[jsc] {rel} -> .jsc")
        # 3. clean up
        os.remove(src)
        os.remove(cjs_tmp)


def transform_remaining_to_cjs():
    """将构建目录里剩下的 .js 源文件（未被 bytenode 编译的、loader、test 之外）经
    esbuild 转成 CJS，让运行时统一为 CJS。"""
    esbuild_bin = local_bin("esbuild")
    skip_suffixes = (".test.js", ".cjs.tmp.js")
    skip_dirs_prefix = ("node_modules",)

    for root, dirs, files in os.walk(JSC_DIR):
        rel_root = os.path.relpath(root, JSC_DIR)
        first = rel_root.split(os.sep)[0] if rel_root != "." else ""
        if first in skip_dirs_prefix:
            dirs[:] = []
            continue
        for name in files:
            if not name.endswith(".js") or name.endswith(skip_suffixes):
                continue
            src = os.path.join(root, name)
            tmp_out = src + ".cjs.tmp"
            run(f'"{esbuild_bin}" --log-level=error --format=cjs --platform=node --target=node18 "{src}" --outfile="{tmp_out}"')
            shutil.move(tmp_out, src)
            print(f"[cjs] {os.path.relpath(src, JSC_DIR)}")

def create_loader():
    """创建自定义 loader：安装 .js → .jsc 的 require 钩子，然后加载 entry。

    bytenode 编译后的 .jsc 字节码里依然写着 require('./foo.js') 这种字面量
    (esbuild 不会改后缀，bytenode 也不会)。pkg 静态分析时只看 JS 源码
    里的 require，字节码里的 require 它看不见，所以 ./foo.js 不在 snapshot 里
    会直接 MODULE_NOT_FOUND。在 loader 入口处装一个 Module._resolveFilename
    钩子把 .js 解析为 .jsc，问题就解决了。
    """
    loader_js = os.path.join(JSC_DIR, "__loader.js")
    with open(loader_js, "w", encoding="utf-8") as f:
        f.write(r'''// BYOK Protected Sidecar Loader — V8 Bytecode
// 1. 装 require 钩子：把 ./foo.js 解析为 ./foo.jsc（bytenode 字节码里
//    的 require 字面量还带 .js 后缀，pkg 静态分析看不见，必须在运行时改）。
// 2. 静态 require 入口 .jsc：让 pkg 把这三个 .jsc 打进 snapshot。
const Module = require('module');
const bytenode = require('bytenode');

const _origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.endsWith('.js')) {
    const jscRequest = request.slice(0, -3) + '.jsc';
    try {
      return _origResolveFilename.call(this, jscRequest, parent, isMain, options);
    } catch (e) {
      // .jsc 不存在则退回 .js
    }
  }
  return _origResolveFilename.call(this, request, parent, isMain, options);
};

const target = process.argv[2] || 'proxy-entry';
if (target === 'hybrid-server') {
  require('./hybrid-server.jsc');
} else if (target === 'inference-proxy') {
  require('./inference-proxy.jsc');
} else if (target === 'proxy-entry') {
  require('./proxy-entry.jsc');
} else {
  console.error('Unknown entry:', target);
  process.exit(1);
}
''')

def pkg_bundle(os_name, arch):
    """用 pkg 打包最终二进制"""
    os.makedirs(OUT_DIR, exist_ok=True)

    pkg_target = get_pkg_target(os_name, arch)
    tauri_triple = get_tauri_triple(os_name, arch)
    sidecar_filename = get_sidecar_filename(os_name, tauri_triple)

    # 修改 package.json 指向 loader，并覆盖 sidecar 源码的 "type": "module"
    # 让运行时（loader + .jsc + 残留 .js）统一为 CJS。
    pkg_json = os.path.join(JSC_DIR, "package.json")
    with open(pkg_json, "r", encoding="utf-8") as f:
        pkg = json.load(f)
    pkg["bin"] = "__loader.js"
    pkg["type"] = "commonjs"
    pkg["pkg"] = {
        "assets": [
            "**/*.jsc",
            "*.jsc",
            "handlers/*.jsc",
            "*.js",
            "lib/**/*.js",
            "**/*.json",
            "windsurf-catalog.json",
            "node_modules/bytenode/**/*",
            "prompts/**/*",
            "certs/**/*"
        ],
        "targets": [pkg_target]
    }
    with open(pkg_json, "w", encoding="utf-8") as f:
        json.dump(pkg, f, indent=2)

    # 直接调用本地 @yao-pkg/pkg，避免 npx 在 JSC_DIR 找不到本地 pkg
    # 跑去 npm registry 拉过时的 pkg@5.x。@yao-pkg/pkg v6.20 中 --output 与
    # --out-path 互斥，所以 --output 传完整路径。原脚本从 bin 字段取名是错的
    # —— @yao-pkg/pkg 默认用 name 字段产出 anybridge-sidecar.exe。
    pkg_bin = local_bin("pkg")
    pkg_output_full = os.path.join(OUT_DIR, sidecar_filename)
    run(f'"{pkg_bin}" "{JSC_DIR}" --output "{pkg_output_full}"', cwd=SIDECAR_DIR)

    # 验证输出并加可执行位 (非 Windows)
    if os.path.exists(pkg_output_full):
        if os_name != "windows":
            os.chmod(pkg_output_full, 0o755)
        print(f"[out] {pkg_output_full}")
    else:
        print(f"[warn] pkg output not found: {pkg_output_full}")
        for f in os.listdir(OUT_DIR):
            print(f"  found: {f}")

def main():
    parser = argparse.ArgumentParser(description="Build the protected bytenode/pkg sidecar for Tauri externalBin.")
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

    print(f"[platform] os={os_name}, arch={arch}")
    print(f"[platform] pkg_target={get_pkg_target(os_name, arch)}")
    print(f"[platform] tauri_triple={get_tauri_triple(os_name, arch)}")
    print(f"[platform] sidecar_filename={get_sidecar_filename(os_name, get_tauri_triple(os_name, arch))}")

    clean()
    copy_source()
    bytenode_compile()
    transform_remaining_to_cjs()
    create_loader()
    pkg_bundle(os_name, arch)
    print("\n[done] Protected sidecar built successfully.")

if __name__ == "__main__":
    main()
