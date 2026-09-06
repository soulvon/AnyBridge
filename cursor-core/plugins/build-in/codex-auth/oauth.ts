import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { OAuth2AddMethod, OAuth2Begin, OAuth2Poll } from "cursor-byok:resource";
import { type CredentialCandidate, credentialDraft } from "./resources.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const VERIFICATION_URI = "https://auth.openai.com/codex/device";

type Session = {
  deviceAuthId: string;
  userCode: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseBody(body: string): Record<string, unknown> {
  try {
    return object(JSON.parse(body)) ?? {};
  } catch {
    return {};
  }
}

function parseSession(value: JsonValue): Session {
  const session = object(value);
  const deviceAuthId = text(session?.deviceAuthId);
  const userCode = text(session?.userCode);
  if (!deviceAuthId || !userCode) throw new Error("Codex OAuth session is invalid");
  return { deviceAuthId, userCode };
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error;
  if (typeof error === "string") return error;
  const nested = object(error);
  return text(nested?.code ?? nested?.type ?? body.status ?? body.state) ?? "";
}

function errorMessage(body: Record<string, unknown>): string | null {
  const error = object(body.error);
  return text(body.error_description ?? body.message ?? error?.message);
}

function pendingMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("authorization is pending") ||
    lower.includes("authorization_pending") ||
    lower.includes("device authorization is pending");
}

async function begin(context: PluginContext): Promise<OAuth2Begin> {
  const response = await context.network.fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const body = parseBody(response.body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Failed to request OpenAI Codex device code (HTTP ${response.status}): ${response.body}`,
    );
  }
  const deviceAuthId = text(body.device_auth_id ?? body.device_code);
  const userCode = text(body.user_code ?? body.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI Codex device authorization response is incomplete");
  }
  const session: Session = { deviceAuthId, userCode };
  return {
    session: session as unknown as JsonValue,
    userCode,
    verificationUrl: VERIFICATION_URI,
    verificationUrlComplete: VERIFICATION_URI,
    expiresAtMs: Date.now() + Math.max(1, number(body.expires_in) ?? 900) * 1000,
    pollIntervalMs: Math.max(1, number(body.interval) ?? 5) * 1000,
  };
}

async function exchangeAuthorizationCode(
  context: PluginContext,
  authorizationCode: string,
  codeVerifier: string,
): Promise<CredentialCandidate> {
  const response = await context.network.fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  const body = parseBody(response.body);
  const accessToken = text(body.access_token);
  if (!accessToken) {
    throw new Error(
      errorMessage(body) ?? `Failed to exchange Codex authorization code (HTTP ${response.status})`,
    );
  }
  return { accessToken, refreshToken: text(body.refresh_token), displayName: null };
}

async function completed(credential: CredentialCandidate): Promise<OAuth2Poll> {
  return { status: "completed", resources: [await credentialDraft(credential)] };
}

async function poll(sessionValue: JsonValue, context: PluginContext): Promise<OAuth2Poll> {
  const session = parseSession(sessionValue);
  const response = await context.network.fetch(DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      device_auth_id: session.deviceAuthId,
      user_code: session.userCode,
    }),
  });
  const body = parseBody(response.body);
  // 该端点用 403/404 表示"尚未完成授权"。
  if (response.status === 403 || response.status === 404) return { status: "pending" };

  const code = errorCode(body);
  const message = errorMessage(body);
  if (
    ["authorization_pending", "pending", "waiting", "in_progress", "device_authorization_pending"]
      .includes(code) ||
    (message !== null && pendingMessage(message))
  ) {
    return { status: "pending" };
  }
  if (code === "slow_down") return { status: "slow-down" };
  if (code === "expired_token" || code === "expired") {
    return { status: "failed", message: message ?? "Device authorization code expired" };
  }
  if (code === "access_denied" || code === "denied") {
    return { status: "denied", message: message ?? undefined };
  }

  const directToken = text(body.access_token);
  if (directToken) {
    return await completed({
      accessToken: directToken,
      refreshToken: text(body.refresh_token),
      displayName: null,
    });
  }

  const authorizationCode = text(body.authorization_code);
  const codeVerifier = text(body.code_verifier);
  if (response.status >= 200 && response.status < 300 && authorizationCode && codeVerifier) {
    try {
      return await completed(
        await exchangeAuthorizationCode(context, authorizationCode, codeVerifier),
      );
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!code && body.error === undefined && response.status >= 400) return { status: "pending" };
  return {
    status: "failed",
    message: message ??
      (code
        ? `OAuth error: ${code}`
        : `Codex device authorization failed (HTTP ${response.status})`),
  };
}

export const codexDeviceOAuth: OAuth2AddMethod = {
  type: "oauth2.0",
  id: "chatgpt-device",
  displayName: {
    "en-US": "Sign in with ChatGPT",
    "zh-CN": "使用 ChatGPT 登录",
  },
  description: {
    "en-US": "Authorize this device with OpenAI, then add the resulting ChatGPT account.",
    "zh-CN": "在 OpenAI 完成设备授权后,自动添加对应的 ChatGPT 账号。",
  },
  begin,
  poll,
};
