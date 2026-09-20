#!/usr/bin/env python3
"""
修复 Linux AppImage 内被 linuxdeploy patchelf 破坏的 pkg sidecar (Issue #33)。

## 背景

tauri-bundler 打 AppImage 时调用 linuxdeploy，后者会对 AppDir/usr/bin 下所有 ELF
可执行文件做依赖部署并用 patchelf 写入 RUNPATH。patchelf 为写入 RUNPATH 会新增
LOAD 程序头并**重排文件偏移**，而 pkg (@yao-pkg/pkg) 把 JS payload 追加在文件尾部，
绝对偏移随之错位 -> readPrelude 读到错误内容 -> SyntaxError -> sidecar 秒退，
7450 端口不监听，AppImage 表现为白屏、代理不可用。

NO_STRIP=true 只能阻止 gtk 插件的 strip 子步骤，无法阻止 patchelf。
linuxdeploy 没有"跳过指定可执行文件"的选项。

## 修复策略（yangjuncode 在 Issue #33 中端到端验证过的方向 1）

1. `--appimage-extract` 解包 AppImage；
2. 用 `src-tauri/binaries/anybridge-<triple>`（未 patchelf 的原始文件）覆盖
   `squashfs-root/usr/bin/anybridge-proxy`；
3. 用 tauri 缓存的 `linuxdeploy-plugin-appimage` 重新打包；
4. 校验重打包产物内的 sidecar 与原始文件 hash 一致，并做启动冒烟。

修复后 AppImage 内容发生变化，其上一步的 updater 签名 (.sig) 随之失效，
必须由调用方（release workflow）重新签名并覆盖上传。本脚本只负责修复产物本身。
"""

import argparse
import glob
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time

SIDECAR_REL_PATH = os.path.join('usr', 'bin', 'anybridge-proxy')


def log(msg):
    print(msg, flush=True)


def fatal(msg):
    print('FATAL: ' + msg, file=sys.stderr, flush=True)
    sys.exit(1)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run(cmd, cwd=None, env=None, capture=False):
    log('  $ ' + ' '.join(cmd))
    if capture:
        return subprocess.run(cmd, cwd=cwd, env=env, check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.decode('utf-8', 'replace')
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def resolve_appimage(appimage_arg):
    if appimage_arg:
        if not os.path.isfile(appimage_arg):
            fatal('指定的 AppImage 不存在: ' + appimage_arg)
        return os.path.abspath(appimage_arg)
    found = sorted(glob.glob(os.path.join('src-tauri', 'target', 'release', 'bundle', 'appimage', '*.AppImage')))
    # 排除解包残留与签名文件
    found = [p for p in found if not p.endswith('.sig')]
    if not found:
        fatal('未在 bundle/appimage 下找到 AppImage 产物')
    return os.path.abspath(found[0])


def find_plugin_appimage():
    """定位 tauri 缓存中的 linuxdeploy-plugin-appimage（刚构建过，必然存在）。"""
    cache = os.path.join(os.path.expanduser('~'), '.cache', 'tauri')
    if not os.path.isdir(cache):
        fatal('tauri 缓存目录不存在: %s（AppImage 构建应已生成它）' % cache)
    matches = [p for p in glob.glob(os.path.join(cache, '*plugin-appimage*'))
               if os.path.isfile(p)]
    if not matches:
        fatal('未在 %s 找到 linuxdeploy-plugin-appimage，无法重新打包 AppImage' % cache)
    return os.path.abspath(sorted(matches)[0])


def extract_appimage(appimage, workdir):
    """解包 AppImage 到 workdir/squashfs-root。"""
    run([appimage, '--appimage-extract'], cwd=workdir)
    root = os.path.join(workdir, 'squashfs-root')
    if not os.path.isdir(root):
        fatal('解包失败，未生成 squashfs-root')
    return root


def smoke_test_sidecar(binary, wait_seconds=6):
    """
    启动 sidecar 冒烟：被 patchelf 破坏的 pkg 产物会在启动瞬间 SyntaxError 秒退，
    完好产物会持续存活并监听端口。任一异常都显式失败，不做静默降级。
    """
    env = os.environ.copy()
    env['BYOK_CONFIG_DIR'] = tempfile.mkdtemp(prefix='byok-smoke-')
    env['API_PORT'] = '17450'
    env['INFERENCE_PORT'] = '17451'

    log('--- sidecar 启动冒烟 ---')
    proc = subprocess.Popen([binary], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    time.sleep(wait_seconds)

    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log('sidecar 启动后持续存活，pkg payload 完整')
        return True

    code = proc.returncode
    out = proc.stdout.read().decode('utf-8', 'replace') if proc.stdout else ''
    log('sidecar 已退出，退出码=%s' % code)
    if out.strip():
        log('--- sidecar 输出 ---\n' + out.strip())
    if 'SyntaxError' in out or 'readPrelude' in out:
        fatal('sidecar 仍被 patchelf 破坏（pkg payload 偏移错位），修复未生效')
    if code and code > 128:
        fatal('sidecar 被信号 %d 终止' % (code - 128))
    fatal('sidecar 启动即退出（退出码=%s），修复未通过冒烟验证' % code)


def main():
    ap = argparse.ArgumentParser(description='修复 AppImage 内被 patchelf 破坏的 sidecar')
    ap.add_argument('--appimage', default='', help='待修复的 AppImage 路径（默认自动查找 bundle/appimage）')
    ap.add_argument('--sidecar', required=True, help='未 patchelf 的原始 sidecar 文件路径')
    ap.add_argument('--arch', default='x86_64', help='AppImage 目标架构，默认 x86_64')
    args = ap.parse_args()

    sidecar_src = os.path.abspath(args.sidecar)
    if not os.path.isfile(sidecar_src):
        fatal('原始 sidecar 不存在: %s' % sidecar_src)
    sidecar_hash = sha256_file(sidecar_src)
    log('原始 sidecar: %s' % sidecar_src)
    log('  sha256 = %s' % sidecar_hash)

    appimage = resolve_appimage(args.appimage)
    log('待修复 AppImage: %s' % appimage)
    os.chmod(appimage, 0o755)
    before_hash = sha256_file(appimage)
    log('  修复前 sha256 = %s' % before_hash)

    plugin = find_plugin_appimage()
    log('重打包工具: %s' % plugin)

    workdir = tempfile.mkdtemp(prefix='appimage-repair-')
    try:
        # 1) 解包
        root = extract_appimage(appimage, workdir)

        # 2) 检查当前 sidecar 状态
        packed = os.path.join(root, SIDECAR_REL_PATH)
        if not os.path.isfile(packed):
            fatal('AppImage 内未找到 sidecar: %s' % SIDECAR_REL_PATH)
        packed_hash = sha256_file(packed)
        log('AppImage 内 sidecar sha256 = %s' % packed_hash)
        if packed_hash == sidecar_hash:
            log('AppImage 内 sidecar 与原始文件一致，无需修复（linuxdeploy 未改写）')
            return 0
        log('检测到 sidecar 已被改写（hash 不一致），执行还原')

        # 3) 用原始文件覆盖
        shutil.copyfile(sidecar_src, packed)
        os.chmod(packed, 0o755)
        if sha256_file(packed) != sidecar_hash:
            fatal('覆盖后 hash 仍不一致，还原失败')

        # 4) 重新打包
        env = os.environ.copy()
        env['ARCH'] = args.arch
        run([plugin, '--appdir', root, '--output', 'appimage'], cwd=workdir, env=env)

        produced = [p for p in glob.glob(os.path.join(workdir, '*.AppImage'))]
        if not produced:
            fatal('重新打包未产出 AppImage')
        fresh = os.path.abspath(sorted(produced, key=os.path.getmtime)[-1])
        log('重新打包产物: %s' % fresh)

        # 5) 覆盖回原路径
        shutil.move(fresh, appimage)
        os.chmod(appimage, 0o755)
        after_hash = sha256_file(appimage)
        log('修复后 AppImage sha256 = %s' % after_hash)
        if after_hash == before_hash:
            fatal('修复后 AppImage 内容未变化，重打包可能未生效')

        # 6) 复核：重新解包验证内部 sidecar，并做启动冒烟
        verify_dir = tempfile.mkdtemp(prefix='appimage-verify-')
        try:
            vroot = extract_appimage(appimage, verify_dir)
            vpacked = os.path.join(vroot, SIDECAR_REL_PATH)
            vhash = sha256_file(vpacked)
            log('复核：修复后镜像内 sidecar sha256 = %s' % vhash)
            if vhash != sidecar_hash:
                fatal('复核失败：修复后镜像内 sidecar 仍与原始文件不一致')
            smoke_test_sidecar(vpacked)
        finally:
            shutil.rmtree(verify_dir, ignore_errors=True)

        log('✅ AppImage sidecar 修复完成并通过验证')
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
