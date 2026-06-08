"""Test with different models and the /v1/responses endpoint."""
import urllib.request
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
ctx = ssl.create_default_context()

models_to_test = [
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-opus-4-6",
]

for model in models_to_test:
    print(f"\n{'='*60}")
    print(f"Model: {model}")
    print(f"{'='*60}")

    # Anthropic format
    body = json.dumps({
        "model": model,
        "max_tokens": 10,
        "stream": False,
        "messages": [{"role": "user", "content": "say hi"}],
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/v1/messages",
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            print(f"  Anthropic: {resp.status} — {resp.read().decode()[:200]}")
    except urllib.error.HTTPError as e:
        print(f"  Anthropic: {e.code} — {e.read().decode()[:200]}")

    # OpenAI Responses API format
    body = json.dumps({
        "model": model,
        "input": [{"role": "user", "content": "say hi"}],
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/v1/responses",
        data=body,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            print(f"  Responses: {resp.status} — {resp.read().decode()[:200]}")
    except urllib.error.HTTPError as e:
        print(f"  Responses: {e.code} — {e.read().decode()[:200]}")

    # OpenAI Chat Completions format
    body = json.dumps({
        "model": model,
        "max_tokens": 10,
        "messages": [{"role": "user", "content": "say hi"}],
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/v1/chat/completions",
        data=body,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            print(f"  ChatComp:  {resp.status} — {resp.read().decode()[:200]}")
    except urllib.error.HTTPError as e:
        print(f"  ChatComp:  {e.code} — {e.read().decode()[:200]}")
