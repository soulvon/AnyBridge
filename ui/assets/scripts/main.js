/**
 * AnyBridge UI entry (ES module)
 * P4: shared layers first (api/ui/state), then feature modules.
 * Bindings still mirrored to globalThis for data-action + free vars.
 */
import './api/bridge.js';
import './ui/dom.js';
import './ui/feedback.js';
import './state/logs.js';
import './05-actions.js';
import './10-shell.js';
import './20-runtime.js';
import './30-providers-eval.js';
import './40-model-picker.js';
import './50-model-map.js';
import './52-proxy-routes.js';
import './model-context-presets.js';
import './55-platforms.js';
import './65-extensions.js';
import './60-updater.js';
import './70-healthcheck.js';
import './90-init.js';
