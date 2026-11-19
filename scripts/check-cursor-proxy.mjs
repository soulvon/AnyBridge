import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProxyRoutes } from './lib/cursor-proxy/harness.mjs';
import { runModelsBugbotGlobChecks } from './lib/cursor-proxy/models-bugbot-glob.mjs';
import { runGrepAndEditToolChecks } from './lib/cursor-proxy/grep-and-edit-tools.mjs';
import { runBackgroundAndSessionChecks } from './lib/cursor-proxy/background-and-session.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anybridge-cursor-proxy-'));
process.env.BYOK_CONFIG_DIR = tmp;

try {
  writeProxyRoutes([]);
  const { markProxyRoutesDirty } = await import('../sidecar/config-cache.js');
  const { __cursorProxyTest, handleCursorRequest, isCursorHost } = await import('../sidecar/cursor-proxy.js');
  await runModelsBugbotGlobChecks({ markProxyRoutesDirty, __cursorProxyTest, handleCursorRequest, isCursorHost });
  await runGrepAndEditToolChecks({ tmp, __cursorProxyTest, handleCursorRequest });
  await runBackgroundAndSessionChecks({ tmp, __cursorProxyTest, handleCursorRequest });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
