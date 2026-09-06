#!/usr/bin/env python3
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
    system = platform.system().lower()
    machine = platform.machine().lower()
    triple = TRIPLES.get((system, machine))
    if not triple:
        raise RuntimeError(f"Unsupported build platform: {system}/{machine}")

    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", "1")
    env.setdefault("CARGO_INCREMENTAL", "0")
    subprocess.run(
        ["cargo", "build", "--release", "--manifest-path", str(CORE / "Cargo.toml")],
        cwd=ROOT,
        env=env,
        check=True,
    )

    suffix = ".exe" if system == "windows" else ""
    source = CORE / "target" / "release" / f"anybridge-cursor-core{suffix}"
    destination = BINARIES / f"anybridge-cursor-core-{triple}{suffix}"
    BINARIES.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    if system != "windows":
        destination.chmod(0o755)
    print(destination)


if __name__ == "__main__":
    main()
