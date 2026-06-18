// proxy-entry.js — Unified sidecar entry for AnyBridge.
// Import order matters: load-env first (populates process.env),
// then the two server modules (which read env + listen at top level).
// All imports are static so pkg can snapshot them.

import './load-env.js';
import './hybrid-server.js';
import './inference-proxy.js';

console.log('[entry] both proxies started');
