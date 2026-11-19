#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchCdpSession, REPO_ROOT } from './lib/cdp-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEV_SANDBOX_SCRIPT = path.join(__dirname, 'dev-sandbox.mjs');
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'tmp', 'ui-screenshots');
const ALLOW_LEGACY_FONT = process.argv.includes('--allow-legacy-font');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function startIsolatedSandbox(sandboxDir) {
  fs.mkdirSync(sandboxDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [DEV_SANDBOX_SCRIPT, '--no-sidecar', '--port', '0', '--reseed', '--sandbox-dir', sandboxDir],
    { cwd: REPO_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let logs = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev-sandbox start timeout:\n${logs}`)), 15000);
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      logs += text;
      const m = logs.match(/\[dev-sandbox\]\s+listening on\s+(http:\/\/127\.0\.0\.1:\d+)/i);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dev-sandbox exited prematurely (${code}):\n${logs}`));
    });
  });

  const stop = async () => {
    if (child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
      await sleep(200);
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
  };

  return { url, stop, getLogs: () => logs };
}

async function navigateAndCheck(cdp, pageId, shotName, opts = {}) {
  const { waitMs = 260, checkScroll = true } = opts;
  await cdp.evaluate(`(async () => {
    if (typeof navigateTo === 'function') await navigateTo(${JSON.stringify(pageId)});
  })()`);
  await sleep(waitMs);

  const metrics = await cdp.evaluate(`(() => {
    const active = document.querySelector('.page.active');
    const rect = active ? active.getBoundingClientRect() : { width: 0, height: 0 };
    const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const pageOverflow = active ? (active.scrollWidth - active.clientWidth) : 0;
    const alertActive = document.getElementById('custom-alert-modal')?.classList.contains('active') || false;
    const onboardingActive = document.getElementById('onboarding-guide-modal')?.classList.contains('active') || false;
    const alertTitle = alertActive ? (document.getElementById('custom-alert-title')?.textContent || '') : '';
    return {
      activeId: active ? active.id : null,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      docOverflow: Math.round(docOverflow),
      pageOverflow: Math.round(pageOverflow),
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      alertActive,
      alertTitle,
      onboardingActive,
    };
  })()`);

  assert(metrics.activeId, `[${shotName}] 未找到激活页 .page.active`);
  assert(metrics.width > 200 && metrics.height > 200, `[${shotName}] 激活页 ${metrics.activeId} 尺寸异常: ${metrics.width}x${metrics.height}`);
  assert(!metrics.alertActive, `[${shotName}] 意外弹出错误弹窗: ${metrics.alertTitle}`);
  assert(!metrics.onboardingActive, `[${shotName}] 新手引导弹窗未抑制`);
  if (checkScroll) {
    assert(
      metrics.scrollWidth <= metrics.innerWidth + 1,
      `[${shotName}] 页面存在横向溢出: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`,
    );
  }

  if (shotName) {
    await cdp.screenshot(path.join(SCREENSHOT_DIR, `${shotName}.png`));
  }
  return metrics;
}

async function checkProxySubpanels(cdp) {
  await cdp.evaluate(`(async () => { await navigateTo('proxy'); })()`);
  await sleep(260);

  for (const panel of ['overview', 'routes', 'enhancement']) {
    await cdp.evaluate(`(async () => {
      if (typeof activateProxyPanel === 'function') activateProxyPanel(${JSON.stringify(panel)});
    })()`);
    await sleep(220);
    const info = await cdp.evaluate(`(() => {
      const sec = document.querySelector('#page-proxy [data-proxy-section="' + ${JSON.stringify(panel)} + '"]');
      const rect = sec ? sec.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        exists: Boolean(sec),
        active: sec ? sec.classList.contains('active') : false,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()`);
    assert(info.exists && info.active, `[proxy:${panel}] 子面板未激活`);
    assert(info.width > 200 && info.height > 200, `[proxy:${panel}] 子面板尺寸过小: ${info.width}x${info.height}`);
    assert(info.scrollWidth <= info.innerWidth + 1, `[proxy:${panel}] 横向溢出: ${info.scrollWidth} > ${info.innerWidth}`);
    await cdp.screenshot(path.join(SCREENSHOT_DIR, `proxy-${panel}.png`));
  }

  // logs 子面板：支持 section 切换或网关抽屉 #gatewayDrawerLogs -> #proxyLogsMount
  await cdp.evaluate(`(() => {
    if (typeof activateProxyPanel === 'function') activateProxyPanel('logs');
    const mask = document.getElementById('gatewayDrawerMask');
    const sec = document.querySelector('#page-proxy [data-proxy-section="logs"]');
    const secVisible = sec && getComputedStyle(sec).display !== 'none';
    const maskVisible = mask && getComputedStyle(mask).display !== 'none';
    if (!secVisible && !maskVisible && typeof toggleGatewayDrawer === 'function') {
      toggleGatewayDrawer(true);
    }
    if (typeof setDrawerSubTab === 'function') setDrawerSubTab('logs');
  })()`);
  await sleep(260);
  const logsInfo = await cdp.evaluate(`(() => {
    const sec = document.querySelector('#page-proxy [data-proxy-section="logs"]');
    const drawer = document.getElementById('gatewayDrawerLogs');
    const mount = document.getElementById('proxyLogsMount');
    const candidates = [sec, drawer, mount].filter(Boolean);
    let best = { width: 0, height: 0, id: '' };
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height > best.width * best.height) {
        best = { id: el.id || el.dataset?.proxySection || 'logs', width: Math.round(r.width), height: Math.round(r.height) };
      }
    }
    return best;
  })()`);
  assert(logsInfo.width > 200 && logsInfo.height > 150, `[proxy:logs] 日志视图不可见或尺寸异常: ${logsInfo.id}=${logsInfo.width}x${logsInfo.height}`);
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'proxy-logs.png'));
  await cdp.evaluate(`(() => { if (typeof toggleGatewayDrawer === 'function') toggleGatewayDrawer(false); })()`);

  // stats 子面板（由 activateProxyPanel('stats') 或直通 page-stats 展示）
  await cdp.evaluate(`(async () => {
    if (typeof activateProxyPanel === 'function') activateProxyPanel('stats');
  })()`);
  await sleep(260);
  const statsInfo = await cdp.evaluate(`(() => {
    const active = document.querySelector('.page.active');
    const r = active ? active.getBoundingClientRect() : { width: 0, height: 0 };
    return { activeId: active?.id || '', width: Math.round(r.width), height: Math.round(r.height), scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  })()`);
  assert(statsInfo.width > 200 && statsInfo.height > 200, `[proxy:stats] 统计视图尺寸异常: ${statsInfo.width}x${statsInfo.height}`);
  assert(statsInfo.scrollWidth <= statsInfo.innerWidth + 1, `[proxy:stats] 横向溢出`);
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'proxy-stats.png'));
}

async function checkProviderEditorFlow(cdp) {
  await cdp.evaluate(`(async () => {
    await navigateTo('providers');
    if (typeof openProviderEditor === 'function') openProviderEditor();
  })()`);
  await sleep(240);
  const createInfo = await cdp.evaluate(`(() => {
    const page = document.getElementById('page-provider-editor');
    const r = page ? page.getBoundingClientRect() : { width: 0, height: 0 };
    return {
      active: page?.classList.contains('active') || false,
      title: document.getElementById('providerModalTitle')?.textContent?.trim() || '',
      pfId: document.getElementById('pf-id')?.value || '',
      width: Math.round(r.width),
      height: Math.round(r.height),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  })()`);
  assert(createInfo.active && createInfo.pfId === '', `[provider-editor:create] 未进入新建态: active=${createInfo.active} pfId=${createInfo.pfId}`);
  assert(createInfo.width > 200 && createInfo.height > 200, `[provider-editor:create] 尺寸异常`);
  assert(createInfo.scrollWidth <= createInfo.innerWidth + 1, `[provider-editor:create] 横向溢出`);
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'provider-editor-create.png'));

  await cdp.evaluate(`(() => {
    if (typeof openProviderEditor === 'function') openProviderEditor('prov-openai-direct');
  })()`);
  await sleep(240);
  const editInfo = await cdp.evaluate(`(() => {
    const page = document.getElementById('page-provider-editor');
    const r = page ? page.getBoundingClientRect() : { width: 0, height: 0 };
    return {
      active: page?.classList.contains('active') || false,
      title: document.getElementById('providerModalTitle')?.textContent?.trim() || '',
      pfId: document.getElementById('pf-id')?.value || '',
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  })()`);
  assert(editInfo.active && editInfo.pfId === 'prov-openai-direct', `[provider-editor:edit] 未绑定指定供应商: pfId=${editInfo.pfId}`);
  assert(editInfo.width > 200 && editInfo.height > 200, `[provider-editor:edit] 尺寸异常`);
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'provider-editor-edit.png'));
  await cdp.evaluate(`(() => { if (typeof closeProviderEditor === 'function') closeProviderEditor(); })()`);
  await sleep(150);
}

async function checkLanguageAndUppercase(cdp) {
  await cdp.evaluate(`(async () => { await navigateTo('providers'); })()`);
  await sleep(200);
  const beforeText = await cdp.evaluate(`document.querySelector('#page-providers .provider-toolbar-title')?.textContent?.trim() || ''`);
  await cdp.evaluate(`(async () => { await window.ByokI18n.setLanguage('en-US'); })()`);
  await sleep(260);
  const enResult = await cdp.evaluate(`(() => {
    const title = document.querySelector('#page-providers .provider-toolbar-title')?.textContent?.trim() || '';
    const navText = Array.from(document.querySelectorAll('.nav-item, .nav-label, [data-i18n]')).slice(0, 12).map(el => el.textContent.trim()).join('|');
    const upperViolations = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (cs.textTransform === 'uppercase' && (el.innerText || '').trim()) {
        upperViolations.push({ tag: el.tagName, cls: el.className, text: (el.innerText || '').trim().slice(0, 32) });
        if (upperViolations.length >= 10) break;
      }
    }
    return { title, navText, upperViolations };
  })()`);
  assert(
    enResult.title !== beforeText || /[A-Za-z]{3,}/.test(enResult.navText),
    `[i18n] 切换 en-US 后文本未发生变化: before="${beforeText}" after="${enResult.title}"`,
  );
  assert(
    enResult.upperViolations.length === 0,
    `[i18n:en-US] 存在 computed textTransform === uppercase 元素: ${JSON.stringify(enResult.upperViolations)}`,
  );
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'providers-en-us.png'));

  await cdp.evaluate(`(async () => { await window.ByokI18n.setLanguage('zh-CN'); })()`);
  await sleep(220);
  const backTitle = await cdp.evaluate(`document.querySelector('#page-providers .provider-toolbar-title')?.textContent?.trim() || ''`);
  assert(backTitle === beforeText, `[i18n] 切回 zh-CN 失败: expected="${beforeText}" got="${backTitle}"`);
}

async function checkSettingsModalAndHidden(cdp) {
  await cdp.evaluate(`(() => {
    if (typeof openSettingsModal === 'function') openSettingsModal();
    else document.getElementById('settings-btn')?.click();
  })()`);
  await sleep(220);

  const modalRect = await cdp.evaluate(`(() => {
    const overlay = document.getElementById('settings-modal');
    const box = overlay?.querySelector('.settings-modal, .modal, .modal-box, .modal-card, .modal-dialog') || overlay?.firstElementChild;
    const r = box ? box.getBoundingClientRect() : { width: 0, height: 0 };
    return { active: overlay?.classList.contains('active') || false, width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  assert(modalRect.active, '#settings-modal 未激活');
  assert(modalRect.width >= 680, `#settings-modal 容器宽度应 >= 680px，实测 ${modalRect.width}px`);
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'settings-modal.png'));

  await cdp.pressKey('Escape');
  await sleep(220);
  const afterEsc = await cdp.evaluate(`document.getElementById('settings-modal')?.classList.contains('active') || false`);
  assert(!afterEsc, '#settings-modal 按 Escape 未关闭');

  const hiddenViolations = await cdp.evaluate(`(() => {
    const probe = document.createElement('div');
    probe.setAttribute('hidden', '');
    probe.className = 'btn-primary provider-toolbar-btn modal-backdrop';
    probe.style.display = '';
    document.body.appendChild(probe);
    const probeDisplay = getComputedStyle(probe).display;
    probe.remove();

    const leaked = [];
    for (const el of document.querySelectorAll('[hidden]')) {
      const d = getComputedStyle(el).display;
      if (d !== 'none') leaked.push({ tag: el.tagName, id: el.id, cls: el.className, display: d });
    }
    return { probeDisplay, leaked };
  })()`);
  assert(hiddenViolations.probeDisplay === 'none', `[hidden] 防穿透失败: 附加类样式覆盖后 display=${hiddenViolations.probeDisplay}`);
  assert(hiddenViolations.leaked.length === 0, `存在未隐藏的 [hidden] 节点: ${JSON.stringify(hiddenViolations.leaked)}`);
}

async function checkNoScrollOnClick(cdp) {
  await cdp.evaluate(`(async () => { await navigateTo('stats'); })()`);
  await sleep(300);
  const res = await cdp.evaluate(`(async () => {
    const candidates = [
      document.querySelector('#page-stats'),
      document.querySelector('.content-area'),
      document.querySelector('.main'),
      document.scrollingElement,
    ].filter(Boolean);
    let target = candidates.find(el => (el.scrollHeight - el.clientHeight) > 140);
    if (!target) {
      await navigateTo('providers');
      await new Promise(r => setTimeout(r, 220));
      target = [document.querySelector('#page-providers'), document.querySelector('.content-area'), document.querySelector('.main'), document.scrollingElement]
        .filter(Boolean)
        .find(el => (el.scrollHeight - el.clientHeight) > 120) || document.scrollingElement;
    }
    const prevTop = target.scrollTop;
    target.scrollTop = 160;
    await new Promise(r => setTimeout(r, 40));
    const afterSet = target.scrollTop;
    const clickable = target.querySelector('.ez-pill-btn[data-stats-range="7"]')
      || target.querySelector('.ez-pill-btn')
      || target.querySelector('.toggle-switch')
      || target.querySelector('button:not(:disabled)');
    if (!clickable) return { skipped: true, reason: 'no interactive control found', afterSet };
    clickable.click();
    await new Promise(r => setTimeout(r, 200));
    const afterClick = target.scrollTop;
    target.scrollTop = prevTop;
    return {
      skipped: false,
      targetId: target.id || target.className || target.tagName,
      maxScroll: target.scrollHeight - target.clientHeight,
      afterSet,
      afterClick,
    };
  })()`);
  assert(!res.skipped, `[no-scroll-on-click] 未找到可交互控件`);
  assert(res.afterSet > 80, `[no-scroll-on-click] 容器未能滚动到 >80px (actual=${res.afterSet}, maxScroll=${res.maxScroll})`);
  assert(res.afterClick > 80, `[no-scroll-on-click] 点击后滚动位置被重置: before=${res.afterSet}, after=${res.afterClick}`);
  return res;
}

async function sampleLeafFontSizes(cdp, pages) {
  const smallHits = [];
  let totalSampled = 0;
  for (const pageId of pages) {
    await cdp.evaluate(`(async () => { await navigateTo(${JSON.stringify(pageId)}); })()`);
    await sleep(220);
    const chunk = await cdp.evaluate(`(() => {
      const active = document.querySelector('.page.active');
      if (!active) return { total: 0, small: [] };
      const small = [];
      let total = 0;
      const walker = document.createTreeWalker(active, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const el = node.parentElement;
        if (!el || el.closest('svg, style, script, [hidden]')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        total++;
        const fs = parseFloat(cs.fontSize);
        if (Number.isFinite(fs) && fs < 12) {
          small.push({
            fontSize: fs,
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 40),
            text: node.nodeValue.trim().slice(0, 24),
          });
        }
      }
      return { total, small };
    })()`);
    totalSampled += chunk.total;
    for (const s of chunk.small.slice(0, 8)) {
      smallHits.push({ page: pageId, ...s });
    }
  }
  return { totalSampled, smallCount: smallHits.length, samples: smallHits.slice(0, 15) };
}

async function main() {
  const sandboxDir = path.join(REPO_ROOT, 'tmp', 'ui-browser-test', `${process.pid}-sandbox`);
  const userDataDir = path.join(REPO_ROOT, 'tmp', 'ui-browser-test', `${process.pid}-profile`);
  fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const sandbox = await startIsolatedSandbox(sandboxDir);
  let cdp = null;
  const results = [];

  const runStep = async (name, fn) => {
    const t0 = Date.now();
    const out = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, ms });
    console.log(`PASS [${name}] (${ms}ms)`);
    return out;
  };

  try {
    console.log(`[test-ui] sandbox=${sandbox.url} strictFont=${!ALLOW_LEGACY_FONT}`);
    cdp = await launchCdpSession({ url: sandbox.url, userDataDir, width: 1600, height: 960 });
    await cdp.waitFor(
      'Boolean(window.__TAURI__?.__SANDBOX__ && window.ByokI18n && typeof navigateTo === "function" && document.querySelector(".page.active"))',
      { timeout: 15000, label: 'UI boot & sandbox bridge' },
    );
    await sleep(600);

    const corePages = [
      'models',
      'providers',
      'platform-antigravity',
      'platform-codex',
      'platform-claude-code',
      'platform-cursor',
      'platform-codebuddy',
      'more-platforms',
      'extensions',
      'stats',
    ];

    await runStep('(c) 核心页面遍历 + 1600x960 无溢出截图', async () => {
      for (const pageId of corePages) {
        await navigateAndCheck(cdp, pageId, `wide-${pageId}`);
      }
      await checkProviderEditorFlow(cdp);
      await checkProxySubpanels(cdp);
    });

    await runStep('(d) 中英双语切换与零 uppercase 校验', async () => {
      await checkLanguageAndUppercase(cdp);
    });

    await runStep('(d2) 多主题切换（dark / claude -> light）渲染校验', async () => {
      await cdp.evaluate(`(() => { if (typeof setTheme === 'function') setTheme('dark'); })()`);
      await sleep(180);
      await navigateAndCheck(cdp, 'models', 'theme-dark-models');
      await cdp.evaluate(`(() => { if (typeof setTheme === 'function') setTheme('claude'); })()`);
      await sleep(180);
      await navigateAndCheck(cdp, 'providers', 'theme-claude-providers');
      await cdp.evaluate(`(() => { if (typeof setTheme === 'function') setTheme('light'); })()`);
      await sleep(180);
    });

    await runStep('(e) 窄桌面 1120x720 双视口零横向溢出', async () => {
      await cdp.setViewport(1120, 720);
      await sleep(160);
      for (const pageId of ['models', 'providers', 'platform-antigravity', 'platform-cursor', 'proxy', 'extensions', 'stats']) {
        await navigateAndCheck(cdp, pageId, `narrow-${pageId}`);
      }
      await cdp.setViewport(1600, 960);
      await sleep(160);
    });

    await runStep('(f) #settings-modal >= 680px, Esc 关闭, [hidden] 防穿透', async () => {
      await checkSettingsModalAndHidden(cdp);
    });

    const scrollRes = await runStep('(g) no scroll on click 交互防跳顶', async () => {
      return checkNoScrollOnClick(cdp);
    });
    console.log(`      scroll check: container=${scrollRes.targetId}, before=${scrollRes.afterSet} -> after=${scrollRes.afterClick}`);

    await runStep('(h) 叶子文本字号 >= 12px', async () => {
      const fontRes = await sampleLeafFontSizes(cdp, ['providers', 'stats', 'extensions', 'proxy', 'models']);
      if (fontRes.smallCount > 0) {
        const msg = `采样 ${fontRes.totalSampled} 处，发现 ${fontRes.smallCount} 处 <12px 样本: ${JSON.stringify(fontRes.samples.slice(0, 8))}`;
        if (!ALLOW_LEGACY_FONT) throw new Error(msg);
        console.warn(`WARN [(h) ${msg}]`);
      } else {
        console.log(`      font check: sampled=${fontRes.totalSampled}, all >= 12px`);
      }
    });

    const exceptions = cdp.getExceptions();
    const consoleErrors = cdp.getConsoleErrors();
    const sandboxLogs = sandbox.getLogs();
    const unhandledLines = sandboxLogs.split(/\r?\n/).filter((l) => l.includes('unhandled invoke'));
    await runStep('(b) Runtime 零异常 / 零 console.error / 零未知 invoke / 零错误弹窗', async () => {
      assert(unhandledLines.length === 0, `存在未处理沙箱 invoke 命令: ${unhandledLines.join(' | ')}`);
      assert(exceptions.length === 0, `存在 Runtime 未捕获异常: ${JSON.stringify(exceptions)}`);
      assert(consoleErrors.length === 0, `存在控制台 console.error: ${JSON.stringify(consoleErrors.slice(0, 10))}`);
      const alertActive = await cdp.evaluate(`document.getElementById('custom-alert-modal')?.classList.contains('active') || false`);
      assert(!alertActive, '结束时存在激活中的 #custom-alert-modal');
    });

    console.log(`\n[test-ui] SUMMARY: ${results.length} checks passed, consoleErrors=0, exceptions=0, screenshots=${SCREENSHOT_DIR}`);
  } finally {
    if (cdp) await cdp.close();
    await sandbox.stop();
  }
}

main().catch((err) => {
  console.error('FAIL [test-ui]:', err?.stack || err);
  process.exit(1);
});
