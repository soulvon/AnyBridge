// 10-shell.js — 模块化拆分聚合入口
import './shell/navigation.js';
import './shell/platform-rail.js';
import './shell/platform-settings-and-lang.js';

globalThis.mountPlatformOwnedSettings?.();
globalThis.activateSettingsPanel?.('appearance');
globalThis.activateProxyPanel?.('overview');
globalThis.syncPlatformSubtabsForPage?.('platform-proxy');
