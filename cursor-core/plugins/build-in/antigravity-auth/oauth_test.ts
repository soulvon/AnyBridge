import type { PluginContext } from "cursor-byok:plugin";
import { antigravityAuthorizationCodeOAuth } from "./oauth.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function context(requests: Array<{ url: string; body?: string }>): PluginContext {
  return {
    network: {
      fetch: async (url, init = {}) => {
        requests.push({ url, body: init.body });
        if (url === "https://oauth2.googleapis.com/token") {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              access_token: "access-token",
              refresh_token: "refresh-token",
              expires_in: 3600,
            }),
          };
        }
        if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
          return { status: 200, headers: {}, body: JSON.stringify({ email: "user@example.com" }) };
        }
        return { status: 500, headers: {}, body: "{}" };
      },
      stream: () => Promise.reject(new Error("stream is not expected")),
    },
    signal: new AbortController().signal,
  };
}

Deno.test("authorization URL uses Core-owned state, callback, and PKCE challenge", async () => {
  assert(
    antigravityAuthorizationCodeOAuth.callback?.port === undefined,
    "Antigravity must let Core allocate an available loopback port",
  );
  const result = await antigravityAuthorizationCodeOAuth.begin(
    {
      redirectUri: "http://127.0.0.1:51121/oauth-callback",
      state: "core-state",
      codeChallenge: "core-challenge",
    },
    context([]),
  );
  const url = new URL(result.authorizationUrl);
  assert(url.searchParams.get("state") === "core-state", "state must come from Core");
  assert(
    url.searchParams.get("redirect_uri")?.endsWith("/oauth-callback"),
    "callback must be forwarded",
  );
  assert(
    url.searchParams.get("code_challenge") === "core-challenge",
    "PKCE challenge must be forwarded",
  );
  assert(url.searchParams.get("code_challenge_method") === "S256", "PKCE must use S256");
});

Deno.test("authorization completion exchanges the code with the Core PKCE verifier", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const resources = await antigravityAuthorizationCodeOAuth.complete(
    { createdAtMs: Date.now() },
    {
      code: "authorization-code",
      redirectUri: "http://127.0.0.1:51121/oauth-callback",
      codeVerifier: "core-verifier",
    },
    context(requests),
  );
  const tokenRequest = requests.find((request) =>
    request.url === "https://oauth2.googleapis.com/token"
  );
  const body = new URLSearchParams(tokenRequest?.body);
  assert(body.get("code") === "authorization-code", "authorization code must be exchanged");
  assert(body.get("code_verifier") === "core-verifier", "PKCE verifier must come from Core");
  assert(resources.length === 1, "one Google account resource must be returned");
  assert(
    resources[0].key === "antigravity:user@example.com",
    "the account email must be the resource key",
  );
});
