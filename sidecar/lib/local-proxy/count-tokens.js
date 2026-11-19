// sidecar/lib/local-proxy/count-tokens.js — Gemini countTokens 独立执行器（含冷却、密钥轮换与瞬时重试）

import {
  buildGeminiCountTokensPayload,
  geminiActionApiPath,
  isVertexEndpoint,
  redactGeminiCredential,
} from '../google-gemini.js';
import { createTargetAttemptRunner, resolveCandidateKeys } from '../attempt-runner.js';
import { cooldownPolicyFromEnhancement, filterTargets, markFailure, markSuccess, targetKey } from '../provider-cooldown.js';
import { loadModelMapConfig, loadProviders, resolveTarget } from '../../provider-pool.js';
import { createTracker } from '../../request-tracker.js';
import { cleanBody } from './normalize.js';
import { LocalProxyUpstreamError, isCodexProxyScope, resolveProxyModel, routeAsSlot } from './routes.js';
import {
  compactText,
  failureMessage,
  requestUpstream,
  retryPolicy,
  sleep,
  upstreamMessage,
} from './transport.js';
import { geminiContents, geminiTools } from './upstream-payload.js';

export async function executeGeminiCountTokens(ctx) {
  const tracker = createTracker({ client: ctx.client || null, route: 'count-tokens', requestedModel: ctx.model });
  const scope = ctx.proxyRouteScope || 'default';
  const resolved = ctx.pinnedRoute
    ? { slot: routeAsSlot(ctx.pinnedRoute), route: ctx.pinnedRoute }
    : resolveProxyModel(ctx.model, 'gemini', { scope, applyRename: !isCodexProxyScope(scope) });
  if (resolved.error) {
    tracker.reject('invalid-request', resolved.error);
    tracker.finish();
    throw new LocalProxyUpstreamError(resolved.error, { status: 400, type: 'invalid_request_error' });
  }
  const providers = loadProviders();
  const mapConfig = loadModelMapConfig();
  const enhancement = mapConfig?.enhancement || {};
  const policy = retryPolicy(enhancement);
  const cooldownPolicy = cooldownPolicyFromEnhancement(enhancement);
  const geminiTargets = (resolved.slot.targets || []).filter((t) => {
    const c = resolveTarget(t, providers);
    return !c.error && c.format === 'gemini';
  });
  const routed = filterTargets(geminiTargets, cooldownPolicy);
  if (routed.allCooling) {
    const minWait = Math.ceil(Math.min(...routed.cooling.map((c) => c.remainingMs)) / 1000);
    const msg = `countTokens 模型「${ctx.model}」的所有 Gemini 目标均在冷却期内（最短剩余 ${minWait} 秒解冻）。`;
    tracker.reject('cooldown', msg);
    tracker.finish();
    throw new LocalProxyUpstreamError(msg, { status: 503, type: 'upstream_error' });
  }

  const failures = [];
  for (const target of routed.targets) {
    let conn = resolveTarget(target, providers);
    if (conn.error) { failures.push({ providerName: target.providerId, message: conn.error }); continue; }
    if (conn.format !== 'gemini') continue;
    const failuresBefore = failures.length;
    tracker.beginAttempt({ provider: conn.providerName, providerId: conn.providerId, model: conn.model });
    let countConn = { ...conn, apiPath: geminiActionApiPath(conn.apiPath, 'countTokens') };
    const isVertex = countConn.isVertex === true || isVertexEndpoint(countConn.host, countConn.apiPath);
    const nativeCountPassthrough = ctx.kind === 'gemini' && ctx.rawBody && typeof ctx.rawBody === 'object' && !Array.isArray(ctx.rawBody);
    const payload = cleanBody(buildGeminiCountTokensPayload({
      isVertex,
      model: countConn.model,
      contents: nativeCountPassthrough && Array.isArray(ctx.rawBody.contents)
        ? structuredClone(ctx.rawBody.contents)
        : geminiContents(ctx.system, ctx.messages, countConn),
      systemInstruction: nativeCountPassthrough
        ? (ctx.rawBody.systemInstruction || ctx.rawBody.system_instruction || undefined)
        : (ctx.system ? { parts: [{ text: ctx.system }] } : undefined),
      tools: nativeCountPassthrough
        ? (ctx.rawBody.tools || undefined)
        : geminiTools(ctx.tools, ctx.rawBody?.tools),
      safetySettings: ctx.rawBody?.safetySettings || ctx.rawBody?.safety_settings || undefined,
    }));
    const attemptRunner = createTargetAttemptRunner({
      conn: countConn,
      keyCandidates: resolveCandidateKeys(conn),
      policy,
      tracker,
      matchReasonText: false,
    });
    while (true) {
      try {
        const r = await requestUpstream(countConn, payload, {});
        if (r.statusCode >= 200 && r.statusCode < 300 && Number.isFinite(Number(r.json?.totalTokens))) {
          markSuccess(targetKey(target));
          tracker.endAttempt({ status: 'ok', statusCode: r.statusCode, ms: r.durationMs });
          tracker.finish();
          return Number(r.json.totalTokens);
        }
        const safeBody = redactGeminiCredential(r.text || '', countConn.apiKey);
        const msg = compactText(upstreamMessage({ statusCode: r.statusCode, json: r.json, text: safeBody }));
        const decision = attemptRunner.evaluateFailure({
          statusCode: r.statusCode,
          headers: r.headers,
          reason: msg,
        });
        if (decision.action !== 'stop') {
          if (decision.action === 'rotate-key') countConn = decision.conn;
          if (decision.waitMs > 0) await sleep(decision.waitMs);
          continue;
        }
        failures.push({
          providerName: countConn.providerName,
          statusCode: r.statusCode,
          body: safeBody,
          message: msg,
        });
        break;
      } catch (e) {
        const safeMsg = redactGeminiCredential(e?.message || String(e), countConn.apiKey);
        const code = e?.code || safeMsg;
        const decision = attemptRunner.evaluateFailure({
          code: e?.code || '',
          reason: safeMsg,
        });
        if (decision.action !== 'stop') {
          if (decision.waitMs > 0) await sleep(decision.waitMs);
          continue;
        }
        failures.push({
          providerName: countConn.providerName,
          code,
          message: safeMsg,
        });
        break;
      }
    }
    if (routed.targets.length > 1 && failures.length > failuresBefore) {
      const last = failures[failures.length - 1];
      markFailure(targetKey(target), {
        statusCode: last.statusCode, code: last.code, reason: last.message, body: last.body,
        providerName: countConn.providerName, model: countConn.model,
      }, cooldownPolicy);
    }
  }
  if (failures.length) {
    tracker.fail('upstream-http', `countTokens 上游失败：${failures.map(failureMessage).join('；')}`);
    tracker.finish();
    throw new LocalProxyUpstreamError(`countTokens 上游失败：${failures.map(failureMessage).join('；')}`, { status: 502, type: 'upstream_error' });
  }
  tracker.fail('not-implemented', 'countTokens requires a native Gemini target');
  tracker.finish();
  throw new LocalProxyUpstreamError('countTokens 需要 Gemini Native 上游目标才能返回官方精确值；当前路由没有原生 Gemini 目标，本地不做字符估算冒充。', { status: 501, type: 'not_implemented' });
}
