/**
 * AnyBridge UI entry (ES module)
 * Side-effect imports in dependency order; bindings live on globalThis.
 */
import './00-bridge.js';
import './05-actions.js';
import './10-shell.js';
import './20-runtime.js';
import './30-providers-eval.js';
import './40-model-picker.js';
import './50-model-map.js';
import './52-proxy-routes.js';
import './55-platforms.js';
import './65-extensions.js';
import './60-updater.js';
import './70-healthcheck.js';
import './90-init.js';
