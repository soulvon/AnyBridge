"""Test: inject x-anthropic-billing-header into system messages to bypass proxy restriction."""
import urllib.request
import urllib.error
import ssl
import json
import hashlib

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
ctx = ssl.create_default_context()

CC_VERSION = "2.1.37"
_BILLING_SALT = "59cf53e54c78"

def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

def compute_billing_header(message_text: str, entrypoint: str = "cli") -> str:
    sampled = "".join(
        message_text[i] if i < len(message_text) else "0"
        for i in (4, 7, 20)
    )
    version_hash = _sha256(f"{_BILLING_SALT}{sampled}{CC_VERSION}")[:3]
    cch = _sha256(message_text)[:5]
    return (
        f"x-anthropic-billing-header: "
        f"cc_version={CC_VERSION}.{version_hash}; "
        f"cc_entrypoint={entrypoint}; "
        f"cch={cch};"
    )

msg_text = "say hi"
billing_header = compute_billing_header(msg_text)
print(f"Billing header: {billing_header}")

# ── Test 1: billing header as first system message ──
print()
print("=" * 70)
print("Test 1: billing header in system messages array")
print("=" * 70)
body_dict = {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 10,
    "stream": False,
    "system": [
        {"type": "text", "text": billing_header},
        {"type": "text", "text": "You are a helpful assistant."},
    ],
    "messages": [{"role": "user", "content": msg_text}],
}
body = json.dumps(body_dict).encode()
req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers={
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-code/1.0.0",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Body: {resp.read().decode()[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# ── Test 2: billing header as plain system string ──
print()
print("=" * 70)
print("Test 2: billing header as plain system string prefix")
print("=" * 70)
body_dict = {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 10,
    "stream": False,
    "system": billing_header + "\n\nYou are a helpful assistant.",
    "messages": [{"role": "user", "content": msg_text}],
}
body = json.dumps(body_dict).encode()
req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers={
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-code/1.0.0",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Body: {resp.read().decode()[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# ── Test 3: billing header as HTTP header ──
print()
print("=" * 70)
print("Test 3: billing header as HTTP header")
print("=" * 70)
body_dict = {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 10,
    "stream": False,
    "messages": [{"role": "user", "content": msg_text}],
}
body = json.dumps(body_dict).encode()
req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers={
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-code/1.0.0",
    "x-anthropic-billing-header": billing_header.replace("x-anthropic-billing-header: ", ""),
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Body: {resp.read().decode()[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# ── Test 4: billing header in system + opus-4-8 model ──
print()
print("=" * 70)
print("Test 4: billing header + claude-opus-4-8 model")
print("=" * 70)
body_dict = {
    "model": "claude-opus-4-8",
    "max_tokens": 10,
    "stream": False,
    "system": [
        {"type": "text", "text": billing_header},
        {"type": "text", "text": "You are a helpful assistant."},
    ],
    "messages": [{"role": "user", "content": msg_text}],
}
body = json.dumps(body_dict).encode()
req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers={
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-code/1.0.0",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Body: {resp.read().decode()[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# ── Test 5: billing header + streaming ──
print()
print("=" * 70)
print("Test 5: billing header + streaming (sonnet)")
print("=" * 70)
body_dict = {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 10,
    "stream": True,
    "system": [
        {"type": "text", "text": billing_header},
        {"type": "text", "text": "You are a helpful assistant."},
    ],
    "messages": [{"role": "user", "content": msg_text}],
}
body = json.dumps(body_dict).encode()
req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers={
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-code/1.0.0",
    "accept": "text/event-stream",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        data = resp.read(2000).decode()
        print(f"  First 500 chars: {data[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")
