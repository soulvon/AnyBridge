#!/usr/bin/env python3
import argparse
import os
import platform
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "cursor-core"
BINARIES = ROOT / "src-tauri" / "binaries"

TRIPLES = {
    ("windows", "amd64"): "x86_64-pc-windows-msvc",
    ("windows", "x86_64"): "x86_64-pc-windows-msvc",
    ("windows", "arm64"): "aarch64-pc-windows-msvc",
    ("darwin", "x86_64"): "x86_64-apple-darwin",
    ("darwin", "arm64"): "aarch64-apple-darwin",
    ("linux", "x86_64"): "x86_64-unknown-linux-gnu",
    ("linux", "aarch64"): "aarch64-unknown-linux-gnu",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default=os.environ.get("RUST_TARGET") or os.environ.get("CARGO_BUILD_TARGET"))
    args = parser.parse_args()

    triple = args.target.strip() if args.target else None
    system = platform.system().lower()
    machine = platform.machine().lower()

    if not triple:
        triple = TRIPLES.get((system, machine))
        if not triple:
            raise RuntimeError(f"Unsupported build platform: {system}/{machine}")

    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", "1")
    env.setdefault("CARGO_INCREMENTAL", "0")

    cmd = ["cargo", "build", "--release", "--manifest-path", str(CORE / "Cargo.toml")]
    if args.target and args.target.strip():
        cmd.extend(["--target", triple])

    subprocess.run(
        cmd,
        cwd=ROOT,
        env=env,
        check=True,
    )

    suffix = ".exe" if "windows" in triple else ""
    if args.target and args.target.strip():
        source = CORE / "target" / triple / "release" / f"anybridge-cursor-core{suffix}"
    else:
        source = CORE / "target" / "release" / f"anybridge-cursor-core{suffix}"

    destination = BINARIES / f"anybridge-cursor-core-{triple}{suffix}"
    BINARIES.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    if "windows" not in triple:
        destination.chmod(0o755)
    if "darwin" in triple and shutil.which("codesign"):
        print(f"[codesign] signing {destination} with ad-hoc signature...")
        subprocess.run(["codesign", "--force", "--sign", "-", str(destination)], check=False)
    print(destination)


if __name__ == "__main__":
    main()
