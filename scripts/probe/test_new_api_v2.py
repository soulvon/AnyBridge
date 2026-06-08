#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import urllib.request
import json

API_BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
API_KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"

def test_anthropic(version, betas=None, model="claude-sonnet-4-6"):
    headers = {
        "x-api-key": API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "anthropic-version": version,
    }
    if betas:
        headers["anthropic-beta"] = betas
    
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 50
    }
    
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{API_BASE}/v1/messages", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode("utf-8", "ignore")[:200]
            return f"OK {r.status}: {body}"
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")[:200]
        return f"HTTP {e.code}: {body}"
    except Exception as e:
        return f"ERR: {e}"

# 测试不同参数组合
print("=== 测试 Anthropic 接口参数 ===")
tests = [
    ("2025-01-01", None),
    ("2024-10-22", None),
    ("2023-06-01", "prompt-caching-2024-07-31"),
    ("2023-06-01", "max-tokens-3-5-sonnet-2024-07-15"),
    ("2023-06-01", "max-tokens-3-5-sonnet-2024-07-15,token-efficient-tools-2025-01-24"),
    ("2023-06-01", "interleaved-thinking-2025-05-14"),
    ("2025-04-01", None),
    ("2025-04-14", None),
]

for ver, betas in tests:
    label = f"v={ver}" + (f" beta={betas}" if betas else "")
    result = test_anthropic(ver, betas)
    print(f"  {label}")
    print(f"    -> {result}")

# 也试试 OpenAI 格式但带特殊 header
print("\n=== 测试 OpenAI 接口 + 特殊参数 ===")
for model in ["claude-sonnet-4-6", "claude-opus-4-8"]:
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 50,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{API_BASE}/v1/chat/completions", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode("utf-8", "ignore")[:200]
            print(f"  {model}: OK {r.status} - {body}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")[:200]
        print(f"  {model}: HTTP {e.code} - {body}")
    except Exception as e:
        print(f"  {model}: ERR - {e}")
