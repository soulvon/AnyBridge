"""
SSO → CPA xai auth.json 转换脚本 (v2)

读取 grok_accounts.json，用 SSO cookie 走 xAI Device Authorization Flow，
生成 CPA (CLIProxyAPI) 兼容的 xai-{email}.json 凭据文件。

流程对齐 Wei-Shaw/sub2api 的 sso_device.go:
  1. GET accounts.x.ai (验证 SSO 登录态)
  2. POST auth.x.ai/oauth2/device/code (获取 device code)
  3. GET verification_uri_complete (打开验证页面)
  4. POST auth.x.ai/oauth2/device/verify (验证 user_code)
  5. POST auth.x.ai/oauth2/device/approve (批准, action=allow)
  6. Poll auth.x.ai/oauth2/token (轮询获取 token)
"""

import json
import time
import base64
import urllib.parse
import urllib.request
import urllib.error
import http.cookiejar
import os
from datetime import datetime, timezone

# ── 常量 ──

OIDC_ISSUER = "https://auth.x.ai"
ACCOUNTS_URL = "https://accounts.x.ai/"
DEVICE_CODE_URL = f"{OIDC_ISSUER}/oauth2/device/code"
DEVICE_VERIFY_URL = f"{OIDC_ISSUER}/oauth2/device/verify"
DEVICE_APPROVE_URL = f"{OIDC_ISSUER}/oauth2/device/approve"
TOKEN_URL = f"{OIDC_ISSUER}/oauth2/token"

CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
SCOPES = "openid profile email offline_access grok-cli:access api:access"

BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

CPA_GROK_BASE_URL = "https://cli-chat-proxy.grok.com/v1"
GROK_VERSION = "0.0.1"
GROK_TOKEN_UA = "grok-cli/0.0.1 (Linux 6.10.0; x86_64) Golang/1.26"

CPA_GROK_HEADERS = {
    "User-Agent": GROK_TOKEN_UA,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-compaction-at": "400000",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": GROK_VERSION,
    "x-xai-token-auth": "xai-grok-cli",
}

# ── HTTP client (带 cookie jar) ──

class HTTPClient:
    def __init__(self, cookies: dict, ua: str = BROWSER_UA):
        self.cookie_jar = http.cookiejar.CookieJar()
        if cookies:
            for name, value in cookies.items():
                for domain in [".x.ai", ".x.com", "accounts.x.ai", "auth.x.ai"]:
                    c = http.cookiejar.Cookie(
                        version=0, name=name, value=value,
                        port=None, port_specified=False,
                        domain=domain, domain_specified=True,
                        domain_initial_dot=domain.startswith("."),
                        path="/", path_specified=True,
                        secure=True, expires=None, discard=False,
                        comment=None, comment_url=None, rest={}, rfc2109=False,
                    )
                    self.cookie_jar.set_cookie(c)
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar),
        )
        self.opener.addheaders = [("User-Agent", ua)]

    def request(self, url, method="GET", data=None, extra_headers=None, timeout=30):
        post_data = None
        headers = {}
        if data is not None:
            post_data = urllib.parse.urlencode(data).encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(url, method=method, data=post_data, headers=headers)
        try:
            resp = self.opener.open(req, timeout=timeout)
            return resp.status, resp.read(), resp.url, dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.url or url, dict(e.headers)
        except Exception as e:
            return 0, str(e).encode(), url, {}

# ── 工具函数 ──

def decode_jwt_payload(token):
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}

def iso_utc_from_unix(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# ── 核心：SSO → Token via Device Flow ──

def sso_to_token(sso, email="", max_timeout=120):
    cookies = {"sso": sso, "sso-rw": sso}
    client = HTTPClient(cookies=cookies, ua=BROWSER_UA)

    # Step 1: 验证 SSO 登录态
    print(f"  [1/6] 验证 SSO 登录态...")
    status, body, final_url, _ = client.request(ACCOUNTS_URL, "GET")
    if status == 401 or "sign-in" in final_url or "sign-up" in final_url:
        print(f"  [!] SSO 无效或已过期 (HTTP {status})")
        return None
    if status < 200 or status >= 400:
        print(f"  [!] SSO 验证失败: HTTP {status}")
        return None
    print(f"  [+] SSO 验证通过 (HTTP {status})")

    # Step 2: 请求 device code
    print(f"  [2/6] 请求 device authorization...")
    status, body, _, _ = client.request(DEVICE_CODE_URL, "POST", data={
        "client_id": CLIENT_ID,
        "scope": SCOPES,
    })
    if status < 200 or status >= 300:
        body_text = body.decode("utf-8", errors="replace")[:500]
        print(f"  [!] Device code 请求失败: HTTP {status} - {body_text}")
        return None

    device = json.loads(body)
    device_code = device.get("device_code")
    user_code = device.get("user_code")
    verify_complete = device.get("verification_uri_complete", "")
    interval = device.get("interval", 5)
    expires_in = device.get("expires_in", 1800)

    if not device_code or not user_code:
        print(f"  [!] Device code 响应不完整: {device}")
        return None
    print(f"  [+] Device code 获取成功, user_code={user_code}")

    # Step 3: GET verification_uri_complete
    print(f"  [3/6] 打开验证页面...")
    if verify_complete:
        status, body, final_url, _ = client.request(verify_complete, "GET")
        if status < 200 or status >= 400:
            print(f"  [!] 验证页面失败: HTTP {status}")
            return None
        print(f"  [+] 验证页面已访问 (HTTP {status})")
    else:
        print(f"  [*] 无 verification_uri_complete, 跳过")

    # Step 4: POST verify
    print(f"  [4/6] 验证 user_code...")
    status, body, final_url, _ = client.request(DEVICE_VERIFY_URL, "POST", data={
        "user_code": user_code,
    })
    if status < 200 or status >= 400:
        body_text = body.decode("utf-8", errors="replace")[:500]
        print(f"  [!] Verify 失败: HTTP {status} - {body_text}")
        return None
    has_consent = "consent" in final_url.lower()
    print(f"  [+] Verify 完成{' (到达 consent 页面)' if has_consent else ' (未到 consent)'}")

    # Step 5: POST approve
    print(f"  [5/6] 批准授权...")
    status, body, final_url, _ = client.request(DEVICE_APPROVE_URL, "POST", data={
        "user_code": user_code,
        "action": "allow",
        "principal_type": "User",
        "principal_id": "",
    })
    if status < 200 or status >= 400:
        body_text = body.decode("utf-8", errors="replace")[:500]
        print(f"  [!] Approve 失败: HTTP {status} - {body_text}")
        return None
    has_done = "done" in final_url.lower()
    print(f"  [+] Approve 完成{' (到达 done 页面)' if has_done else ' (未到 done)'}")

    # Step 6: Poll token
    print(f"  [6/6] 轮询 token...")
    deadline = time.time() + min(expires_in, max_timeout)
    poll_interval = max(interval, 3)

    while time.time() < deadline:
        time.sleep(poll_interval)
        status, body, _, _ = client.request(TOKEN_URL, "POST", data={
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": device_code,
            "client_id": CLIENT_ID,
        })
        if status == 200:
            token = json.loads(body)
            print(f"  [+] Token 获取成功!")
            return token
        try:
            err = json.loads(body)
            err_code = err.get("error", "")
            if err_code == "authorization_pending":
                continue
            elif err_code == "slow_down":
                poll_interval += 5
                continue
            elif err_code == "access_denied":
                print(f"  [!] 授权被拒绝")
                return None
            elif err_code == "expired_token":
                print(f"  [!] Device code 已过期")
                return None
            else:
                print(f"  [!] Token 轮询失败: {err}")
                return None
        except json.JSONDecodeError:
            if status == 0:
                print(f"  [!] 网络错误")
                return None
            print(f"  [!] Token 轮询异常: HTTP {status}")
            return None

    print(f"  [!] 轮询超时")
    return None

def token_to_cpa_record(token, email=""):
    access = token.get("access_token") or ""
    refresh = token.get("refresh_token") or ""
    id_token = token.get("id_token") or ""
    payload = decode_jwt_payload(access)
    id_payload = decode_jwt_payload(id_token) if id_token else {}

    if not email:
        email = id_payload.get("email") or payload.get("email") or ""
    sub = payload.get("sub") or id_payload.get("sub") or ""

    expired = ""
    if "exp" in payload:
        expired = iso_utc_from_unix(payload["exp"])
    elif token.get("expires_in") is not None:
        try:
            expired = iso_utc_from_unix(int(time.time()) + int(token["expires_in"]))
        except Exception:
            pass

    return {
        "type": "xai",
        "auth_kind": "oauth",
        "email": email or "",
        "sub": sub,
        "access_token": access,
        "refresh_token": refresh,
        "id_token": id_token,
        "token_type": token.get("token_type", "Bearer"),
        "expires_in": token.get("expires_in"),
        "expired": expired,
        "last_refresh": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "token_endpoint": TOKEN_URL,
        "base_url": CPA_GROK_BASE_URL,
        "headers": dict(CPA_GROK_HEADERS),
    }

# ── 主流程 ──

def main():
    input_file = r"C:\Users\admin\Desktop\grok_accounts.json"
    output_dir = r"C:\Users\admin\Desktop\cpa_auth_files"
    max_convert = 3

    os.makedirs(output_dir, exist_ok=True)

    print(f"读取账号文件: {input_file}")
    with open(input_file, "r", encoding="utf-8") as f:
        accounts = json.load(f)

    print(f"共 {len(accounts)} 个账号, 尝试转换前 {max_convert} 个\n")

    success = 0
    failed = 0
    results = []

    for i, acc in enumerate(accounts[:max_convert]):
        email = acc.get("email", f"unknown_{i}")
        sso = acc.get("sso", "")
        if not sso:
            print(f"\n[{i+1}/{max_convert}] {email} - 无 SSO, 跳过")
            failed += 1
            results.append({"email": email, "status": "failed", "reason": "no_sso"})
            continue
        print(f"\n[{i+1}/{max_convert}] {email}")
        token = sso_to_token(sso, email)
        if token:
            record = token_to_cpa_record(token, email)
            filename = f"xai-{email}.json"
            filepath = os.path.join(output_dir, filename)
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(record, f, indent=2, ensure_ascii=False)
            print(f"  [+] 已保存: {filepath}")
            success += 1
            results.append({"email": email, "status": "success", "file": filename})
        else:
            print(f"  [-] 转换失败")
            failed += 1
            results.append({"email": email, "status": "failed"})

    print(f"\n{'='*60}")
    print(f"完成: 成功 {success}, 失败 {failed}")
    print(f"输出目录: {output_dir}")

    summary_path = os.path.join(output_dir, "_conversion_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump({"total": len(results), "success": success, "failed": failed, "results": results}, f, indent=2, ensure_ascii=False)
    print(f"摘要: {summary_path}")

if __name__ == "__main__":
    main()
