/**
 * Claude Code CLI tools fingerprint.
 *
 * The upstream provider validates that the tools array matches Claude Code CLI's
 * built-in tool set. We only need the tool *names* (with empty input schemas) to
 * pass this check — descriptions and full schemas are not required.
 *
 * Auto-discovery: on first use (or when CLI version changes), we try to extract
 * tool names from the CLI binary. If that fails, we fall back to the bundled list.
 *
 * To update the bundled list after a CLI upgrade, run:
 *   node scripts/update_cli_tools.cjs   # extracts from CLI binary
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';

// ── Bundled tool names (CLI 2.1.220) ──────────────────────────────────────
const BUNDLED_TOOL_NAMES = [
  'Agent', 'Bash', 'CronCreate', 'CronDelete', 'CronList',
  'Edit', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep',
  'NotebookEdit', 'Read', 'ReportFindings', 'ScheduleWakeup',
  'SendMessage', 'Skill', 'TaskCreate', 'TaskGet', 'TaskList',
  'TaskOutput', 'TaskStop', 'TaskUpdate', 'WaitForMcpServers',
  'WebFetch', 'WebSearch', 'Workflow', 'Write',
];

const BUNDLED_CLI_VERSION = '2.1.220';

// ── Auto-discovery (dev mode only; pkg uses bundled list) ─────────────────
const IS_PKG = !!process.pkg;
let cachedTools = null;
let cachedVersion = null;

function findCliPath() {
  if (IS_PKG) return null;
  try {
    const command = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    const result = execSync(command, {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      shell: process.platform === 'win32' ? undefined : '/bin/sh',
    }).trim();
    return result.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

function getCliVersion() {
  if (IS_PKG) return null;
  try {
    return execSync('claude --version', { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim().split(' ')[0];
  } catch {
    return null;
  }
}

/**
 * Extract tool names from the CLI binary by searching for known patterns.
 * Verifies bundled tool names exist in binary, then discovers additional tools
 * by searching for "name":"Xxx" near "input_schema".
 */
function discoverToolNamesFromBinary(cliPath) {
  try {
    const buf = fs.readFileSync(cliPath);
    const text = buf.toString('latin1');

    const discovered = new Set();

    // Pattern: "name":"XxxYyy" followed by "input_schema" within 3000 chars
    const namePattern = /"name":"([A-Z][a-zA-Z]{2,29})"/g;
    let match;
    while ((match = namePattern.exec(text)) !== null) {
      const name = match[1];
      const after = text.substring(match.index, match.index + 3000);
      if (after.includes('input_schema') || after.includes('inputSchema')) {
        discovered.add(name);
      }
    }

    if (discovered.size >= BUNDLED_TOOL_NAMES.length) {
      return [...discovered].sort();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the CLI tool names. Uses auto-discovery when CLI version differs from
 * bundled version. Falls back to bundled list if discovery fails.
 */
function getCliToolNames() {
  if (cachedTools) return cachedTools;

  if (IS_PKG) {
    cachedTools = BUNDLED_TOOL_NAMES;
    cachedVersion = BUNDLED_CLI_VERSION;
    return cachedTools;
  }

  const cliVersion = getCliVersion();
  cachedVersion = cliVersion;

  if (cliVersion && cliVersion !== BUNDLED_CLI_VERSION) {
    const cliPath = findCliPath();
    if (cliPath) {
      const discovered = discoverToolNamesFromBinary(cliPath);
      if (discovered && discovered.length >= BUNDLED_TOOL_NAMES.length) {
        console.log(`[claudeCode] Auto-discovered ${discovered.length} tools from CLI ${cliVersion}`);
        cachedTools = discovered;
        return cachedTools;
      }
      console.log(`[claudeCode] CLI ${cliVersion} != bundled ${BUNDLED_CLI_VERSION}, discovery incomplete, using bundled list`);
    }
  }

  cachedTools = BUNDLED_TOOL_NAMES;
  return cachedTools;
}

/**
 * Build the tools array for the unlock payload.
 * Uses minimal tool definitions (name + empty schema) to keep payload small.
 */
export function getClaudeCodeCliTools() {
  const names = getCliToolNames();
  return names.map(name => ({
    name,
    input_schema: { type: 'object', properties: {} },
  }));
}

export function getClaudeCodeCliVersion() {
  return cachedVersion || getCliVersion() || BUNDLED_CLI_VERSION;
}
