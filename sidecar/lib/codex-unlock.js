import crypto from 'node:crypto';
import { getClaudeCodeCliTools, getClaudeCodeCliVersion } from './claude-code-cli-tools.js';
import { CLAUDE_CODE_NATIVE_TOOLS } from './claude-code-native-tools-data.js';

// 对齐 2026-08-02 Claude Code CLI v2.1.220 真实抓包的主聊天请求 beta
// 多余的 beta（thinking-token-count/context-management/prompt-caching-scope）会导致 AnyRouter 429
const CLAUDE_CODE_BETA = [
  'claude-code-20250219',
  'context-1m-2025-08-07',
  'interleaved-thinking-2025-05-14',
  'mid-conversation-system-2026-04-07',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
].join(',');

const CLAUDE_CODE_SESSION_ID = crypto.randomUUID();
const CLAUDE_CODE_DEVICE_ID = crypto.randomBytes(32).toString('hex');
const CLAUDE_CODE_SYSTEM_PROMPT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// 内嵌的 Claude Code 原生 tools 指纹（前 21 个，2026-08-03 二分确认）
// 直接 import JS 模块，pkg 打包后自动在 snapshot 中，无需文件 IO
function getClaudeCodeNativeTools() {
  return CLAUDE_CODE_NATIVE_TOOLS;
}
const CODEX_INSTALLATION_ID = crypto.randomUUID();
const CODEX_SESSION_ID = generateUUIDv7();
const CODEX_DESKTOP_USER_AGENT = 'Codex Desktop/0.142.0-alpha.1 (Windows 10.0.26200; x86_64)';
const CODEX_CACHE_KEYS = new Map();
export function generateUUIDv7() {
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(Date.now());

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeCodexUnlock(unlock) {
  if (!unlock || typeof unlock !== 'object' || unlock.enabled === false) return null;
  if (!Array.isArray(unlock.include) || unlock.include.length === 0) {
    throw new Error('Codex unlock requires a non-empty include array');
  }
  if (!unlock.wireApi && !unlock.wire_api) {
    throw new Error('Codex unlock requires wireApi');
  }
  return {
    include: unlock.include,
    wireApi: unlock.wireApi || unlock.wire_api,
  };
}

export function codexUnlockForTarget(conn) {
  // Provider unlocks are capability records only. A route must opt in with
  // target.unlock="codex"; otherwise ordinary OpenAI routes through the same
  // supplier would be silently rewritten into the Codex-only wire contract.
  if (conn?.unlockKind !== 'codex') return null;
  return normalizeCodexUnlock(conn.unlocks?.codex);
}

export function applyCodexUnlockRequiredFields(payload, unlock) {
  // Keep this intentionally minimal. AnyRouter's Codex-only channels were
  // validated against spec/23 with model/input/stream/include/prompt_cache_key;
  // fabricated Desktop-only metadata fields have broken routing before.
  // store:false: local proxy never needs upstream response persistence; some
  // third-party Responses gateways hit disk/temp floors when store defaults on.
  payload.include = unlock.include;
  payload.prompt_cache_key = generateUUIDv7();
  payload.store = false;
  return payload;
}

function codexInputCacheSeed(input) {
  if (Array.isArray(input)) {
    const firstUser = input.find(item => item?.role === 'user');
    if (firstUser) return JSON.stringify(firstUser).slice(0, 8192);
  }
  return JSON.stringify(input || '').slice(0, 8192);
}

export function buildCodexPromptCacheKey(input) {
  const seed = codexInputCacheSeed(input);
  if (!seed) return CODEX_SESSION_ID;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  let key = CODEX_CACHE_KEYS.get(hash);
  if (!key) {
    key = generateUUIDv7();
    CODEX_CACHE_KEYS.set(hash, key);
  }
  return key;
}

export function buildCodexUnlockClientMetadata(sessionId = CODEX_SESSION_ID) {
  const turnId = generateUUIDv7();
  const windowId = `${sessionId}:0`;
  const turnMetadata = {
    installation_id: CODEX_INSTALLATION_ID,
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: 'turn',
    sandbox: 'none',
    turn_started_at_unix_ms: Date.now(),
    workspace_kind: 'project',
  };
  return {
    'x-codex-window-id': windowId,
    thread_id: sessionId,
    'x-codex-turn-metadata': JSON.stringify(turnMetadata),
    'x-codex-installation-id': CODEX_INSTALLATION_ID,
    session_id: sessionId,
    turn_id: turnId,
  };
}

export function codexUnlockHeaders(conn) {
  return {
    authorization: `Bearer ${conn.apiKey}`,
    originator: 'Codex Desktop',
    'user-agent': CODEX_DESKTOP_USER_AGENT,
  };
}

function stainlessArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

function stainlessOs() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'MacOS';
  if (process.platform === 'linux') return 'Linux';
  return process.platform;
}

export function normalizeClaudeCodeUnlock(unlock) {
  if (!unlock || typeof unlock !== 'object' || unlock.enabled === false) return null;
  if (!unlock.wireApi && !unlock.wire_api) {
    throw new Error('Claude Code unlock requires wireApi');
  }
  return {
    wireApi: unlock.wireApi || unlock.wire_api,
  };
}

export function claudeCodeUnlockForTarget(conn) {
  // Same opt-in rule as Codex unlock: provider-level unlocks only describe
  // capability. A concrete target must request the platform-specific contract.
  if (conn?.unlockKind !== 'claudeCode') return null;
  return normalizeClaudeCodeUnlock(conn.unlocks?.claudeCode);
}

export function buildClaudeCodeUnlockPayload({ model, system, messages, maxTokens, stream = true, tools }) {
  const systemBlocks = Array.isArray(system)
    ? system.filter(block => block && typeof block === 'object' && typeof block.text === 'string')
    : (system ? [{ type: 'text', text: String(system) }] : []);
  if (!systemBlocks.some(block => block.text.includes('Claude agent') || block.text.includes('Claude Code'))) {
    systemBlocks.unshift({ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT });
  }
  // 对齐 2026-08-02 真实抓包：thinking 不加 display，不加 context_management
  const payload = {
    model,
    system: systemBlocks.map(block => ({
      ...block,
      cache_control: block.cache_control || { type: 'ephemeral' },
    })),
    messages,
    metadata: {
      user_id: JSON.stringify({
        device_id: CLAUDE_CODE_DEVICE_ID,
        account_uuid: '',
        session_id: CLAUDE_CODE_SESSION_ID,
      }),
    },
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    stream,
  };
  // AnyRouter 要求携带 Claude Code 原生 tools 指纹，同时透传客户端 tools
  const nativeTools = getClaudeCodeNativeTools();
  const clientTools = (tools && tools.length > 0) ? tools : [];
  if (nativeTools && nativeTools.length > 0) {
    // 去重：客户端 tools 中已存在的同名工具不重复追加
    const nativeNames = new Set(nativeTools.map(t => t.name));
    const uniqueClient = clientTools.filter(t => !nativeNames.has(t.name));
    payload.tools = [...nativeTools, ...uniqueClient];
  } else if (clientTools.length > 0) {
    payload.tools = clientTools;
  }
  return payload;
}

export function claudeCodeUnlockHeaders(conn) {
  const cliVersion = getClaudeCodeCliVersion();
  return {
    authorization: `Bearer ${conn.apiKey}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': CLAUDE_CODE_BETA,
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
    'user-agent': `claude-cli/${cliVersion} (external, sdk-cli)`,
    'x-claude-code-session-id': CLAUDE_CODE_SESSION_ID,
    'x-stainless-arch': stainlessArch(),
    'x-stainless-lang': 'js',
    'x-stainless-os': stainlessOs(),
    'x-stainless-package-version': '0.94.0',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-timeout': '600',
  };
}
