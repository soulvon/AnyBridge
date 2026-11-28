// local-proxy.js - OpenAI / Anthropic / Gemini / Antigravity compatible local reverse proxy.
// Core execution loop & HTTP route dispatcher; protocol normalization, payload building,
// transport/retry and SSE emitters live in ./lib/local-proxy/*.js.

import { executeSearchWithFailover } from './handlers/search-sources.js';
import {
  antigravityAuthScopeKey,
  ensureAntigravityAdminControls,
  ensureAntigravityExperiments,
  ensureAntigravityTier,
  fetchOfficialAntigravityModels,
  fetchOfficialAntigravityRaw,
  forwardToOfficialAntigravity,
  getAntigravityMethod,
  isAntigravityBypassMetricsPath,
  isAntigravityPath,
  mergeAntigravityModelsResponse,
  mockAntigravityAdminControls,
  mockAntigravityListExperiments,
  mockAntigravityLoadCodeAssist,
  mockAntigravityUserInfo,
  mockAntigravityUserQuotaSummary,
  mockAntigravityUserSettings,
  resolveAntigravityCustomModel,
  resolveAntigravityQuotaPolicy,
  singleflight,
} from './lib/antigravity-handler.js';
import { createTargetAttemptRunner } from './lib/attempt-runner.js';
import { redactGeminiCredential } from './lib/google-gemini.js';
import { executeGeminiCountTokens } from './lib/local-proxy/count-tokens.js';
import {
  buildAntigravityNormalizedCtx,
  expandResolvedTargets,
  throwAggregatedUpstreamFailure,
  trySelfHealUpstreamPayload,
} from './lib/local-proxy/execute-helpers.js';
import { estimateTokens, normalizeRequest } from './lib/local-proxy/normalize.js';
import {
  antigravityEnvelope,
  geminiResponsePayload,
  handleCountTokens,
  sendAnthropic,
  sendAntigravityStream,
  sendGemini,
  sendGeminiStream,
  sendOpenAIChat,
  sendOpenAIChatStream,
  sendOpenAIResponses,
  sse,
  writeAntigravityStreamError,
} from './lib/local-proxy/response-emitters.js';
import {
  LocalProxyUpstreamError,
  buildAntigravityRouteFromCustomModel,
  cors,
  geminiMethodFromPath,
  geminiModelFromPath,
  handleGeminiModelInfo,
  handleHybridHandshake,
  handleModels,
  isCodexProxyScope,
  isGeminiGenerateContentPath,
  isLocalProxyRequest,
  mapClaudeDesktopModel,
  pathnameOf,
  proxyScopeForPath,
  readProvidersJson,
  resolveProxyModel,
  routeAsSlot,
  sendAnthropicError,
  sendError,
  sendGeminiError,
  sendJson,
  sendRaw,
  validateAuth,
} from './lib/local-proxy/routes.js';
import { finalizeNonStreamResult, selectStreamingAttempt } from './lib/local-proxy/stream-attempt.js';
import { buildLocalProxyTestExports } from './lib/local-proxy/test-bridge.js';
import {
  applyParamOverrides,
  applyToolEnhancement,
  checkRateLimit,
  collectStreamBody,
  compactText,
  extractExtraRespHeaders,
  logRequest,
  maybeVisionFallback,
  requestUpstream,
  requestUpstreamStream,
  retryPolicy,
  safeParse,
  sleep,
  upstreamMessage,
} from './lib/local-proxy/transport.js';
import { upstreamBody } from './lib/local-proxy/upstream-payload.js';
import { cooldownPolicyFromEnhancement, filterTargets, markFailure, markSuccess, targetKey } from './lib/provider-cooldown.js';
import { DEFAULT_SELF_HEAL_CONFIG } from './lib/self-heal.js';
import { loadModelMapConfig, loadProviders, resolveTarget } from './provider-pool.js';
import { createTracker } from './request-tracker.js';

export { isLocalProxyRequest };

export const __localProxyTest = buildLocalProxyTestExports(execute);

export async function execute(ctx) {
  const tracker = ctx.__tracker || createTracker({ client: ctx.client || null, route: 'local-proxy', requestedModel: ctx.model });
  ctx.__tracker = tracker;
  const scope = ctx.proxyRouteScope || 'default';
  const resolved = ctx.pinnedRoute
    ? { slot: routeAsSlot(ctx.pinnedRoute), route: ctx.pinnedRoute }
    : resolveProxyModel(ctx.model, ctx.kind, { scope, applyRename: !isCodexProxyScope(scope) });
  if (resolved.error) {
    tracker.fail('route-unresolved', resolved.error);
    tracker.finish();
    throw new Error(resolved.error);
  }
  const providers = loadProviders();
  const mapConfig = loadModelMapConfig();
  const enhancement = { ...(mapConfig?.enhancement || {}) };
  if (resolved.route?.enhancement) {
    if (resolved.route.enhancement.retry === false) enhancement.retry = false;
    if (resolved.route.enhancement.autoRouting === false) enhancement.autoRouting = false;
  }
  const preserveExtraParams = resolved.route?.enhancement?.preserveExtraParams === true;
  const rawProviderErrors = resolved.route?.enhancement?.rawProviderErrors !== false;
  const selfHealCfg = { ...DEFAULT_SELF_HEAL_CONFIG, ...(enhancement.selfHeal || {}) };
  const effective = await maybeVisionFallback(ctx, resolved.slot, providers, mapConfig);
  effective.preserveExtraParams = preserveExtraParams;
  tracker.streamMode = effective.stream === true;

  if (enhancement.systemPromptPrefixEnabled === true && enhancement.systemPromptPrefix) {
    effective.system = [enhancement.systemPromptPrefix, effective.system].filter(Boolean).join('\n\n') || undefined;
    effective.systemPromptPrefixApplied = enhancement.systemPromptPrefix;
  }
  applyParamOverrides(effective, enhancement);
  applyToolEnhancement(effective, enhancement);

  if (enhancement.rateLimitEnabled === true && enhancement.rateLimitRpm > 0 && !checkRateLimit(ctx.model, enhancement.rateLimitRpm)) {
    throw new LocalProxyUpstreamError(`请求频率超限：${enhancement.rateLimitRpm} RPM`, { status: 429, type: 'rate_limit_error' });
  }
  if (enhancement.requestLogging) logRequest(ctx, 'request');

  const targets = enhancement.autoRouting === false ? [resolved.slot.targets[0]] : [...resolved.slot.targets];
  const policy = retryPolicy(enhancement);
  const failures = [];
  const resolvedTargets = expandResolvedTargets(targets, resolved.route, scope, failures);

  const cooldownPolicy = cooldownPolicyFromEnhancement(enhancement);
  const routed = filterTargets(resolvedTargets, cooldownPolicy);
  if (routed.cooling.length) {
    const lines = routed.cooling.map((c) => `${c.target.providerId}${c.target.model ? `/${c.target.model}` : ''}(剩 ${Math.ceil(c.remainingMs / 1000)}s)`);
    console.warn(`[local-proxy] 🧊 跳过 ${routed.cooling.length} 个冷却中的目标: ${lines.join(', ')}`);
  }
  if (routed.allCooling) {
    const minWait = Math.ceil(Math.min(...routed.cooling.map((c) => c.remainingMs)) / 1000);
    const msg = `模型「${ctx.model}」的所有上游目标均在冷却期内（最短剩余 ${minWait} 秒解冻），按策略直接阻断报错。`;
    tracker.reject('cooldown', msg);
    tracker.finish();
    throw new LocalProxyUpstreamError(msg, { status: 503, type: 'upstream_error' });
  }

  for (const target of routed.targets) {
    if (ctx.signal?.aborted) break;
    let conn = resolveTarget(target, providers);
    if (conn.error) { failures.push({ providerName: target.providerId, message: conn.error }); continue; }
    const failuresBefore = failures.length;
    tracker.beginAttempt({ provider: conn.providerName, providerId: conn.providerId, model: conn.model });
    let payload = upstreamBody(conn, effective);
    const started = Date.now();
    const attemptRunner = createTargetAttemptRunner({
      conn,
      policy,
      tracker,
      startedAt: started,
      matchReasonText: false,
    });
    const healState = { signatureHealed: false, budgetHealed: false, mediaHealed: false, thinkingHealed: false, minimalDowngraded: false };

    const handleNonOkUpstream = async (statusCode, headers, rawErrorText, parsedJson) => {
      const safeErrorText = conn.format === 'gemini' ? redactGeminiCredential(rawErrorText, conn.apiKey) : rawErrorText;
      const msg = compactText(upstreamMessage({ statusCode, json: parsedJson ?? safeParse(safeErrorText), text: safeErrorText }));
      const healedPayload = trySelfHealUpstreamPayload({
        conn,
        payload,
        statusCode,
        rawErrorText,
        safeErrorText,
        selfHealCfg,
        healState,
      });
      if (healedPayload) {
        payload = healedPayload;
        return true;
      }
      const decision = attemptRunner.evaluateFailure({ statusCode, headers, reason: msg });
      if (decision.action !== 'stop') {
        if (decision.action === 'rotate-key') conn = decision.conn;
        if (decision.waitMs > 0) await sleep(decision.waitMs);
        return true;
      }
      failures.push({ providerName: conn.providerName, statusCode, headers, body: safeErrorText, message: msg, wireApi: conn.wireApi });
      return false;
    };

    while (true) {
      if (ctx.signal?.aborted) break;
      try {
        const streamPlan = selectStreamingAttempt(effective, conn, payload);
        if (streamPlan) {
          const { streamConn, streamPayload, allowJsonFallback } = streamPlan;
          const r = await requestUpstreamStream(streamConn, streamPayload, enhancement);
          markSuccess(targetKey(target));
          if (r.statusCode >= 200 && r.statusCode < 300) {
            const extraRespHeaders = extractExtraRespHeaders(enhancement);
            const contentType = String(r.response.headers?.['content-type'] || '');
            if (allowJsonFallback && !contentType.includes('text/event-stream')) {
              const text = await collectStreamBody(r.response);
              return finalizeNonStreamResult(conn, r, safeParse(text), effective, tracker, extraRespHeaders);
            }
            return {
              conn: streamConn,
              stream: true,
              upstreamResponse: r.response,
              extraHeaders: extraRespHeaders,
              watchdog: r.watchdog,
              recentRequestId: tracker.recentRequestId,
              startedAt: started,
              _tracker: tracker,
              _statusCode: r.statusCode,
            };
          }
          const rawErrorText = await collectStreamBody(r.response);
          if (await handleNonOkUpstream(r.statusCode, r.headers, rawErrorText, null)) continue;
          break;
        }

        const r = await requestUpstream(conn, payload, enhancement);
        markSuccess(targetKey(target));
        if (r.statusCode >= 200 && r.statusCode < 300) {
          const out = finalizeNonStreamResult(conn, r, r.json, effective, tracker, extractExtraRespHeaders(enhancement));
          if (enhancement.requestLogging) logRequest({ ...ctx, _response: { statusCode: r.statusCode, text: out.text } }, 'response');
          return out;
        }
        if (await handleNonOkUpstream(r.statusCode, r.headers, r.text || '', r.json)) continue;
        break;
      } catch (e) {
        const safeErrMsg = conn.format === 'gemini' ? redactGeminiCredential(e?.message || String(e), conn.apiKey) : (e?.message || String(e));
        const code = e?.code || safeErrMsg;
        const decision = attemptRunner.evaluateFailure({ code: e?.code || '', reason: safeErrMsg });
        if (decision.action !== 'stop') {
          if (decision.waitMs > 0) await sleep(decision.waitMs);
          continue;
        }
        failures.push({ providerName: conn.providerName, code, message: safeErrMsg });
        break;
      }
    }
    if (routed.targets.length > 1 && failures.length > failuresBefore) {
      const last = failures[failures.length - 1];
      markFailure(targetKey(target), {
        statusCode: last.statusCode, code: last.code, reason: last.message, body: last.body,
        providerName: conn.providerName, model: conn.model,
      }, cooldownPolicy);
    }
  }

  throwAggregatedUpstreamFailure({ failures, rawProviderErrors, tracker, model: ctx.model });
}

async function handleAntigravityRequest(req, res, body, p, json, attachScope) {
  if (isAntigravityBypassMetricsPath(p)) {
    sendJson(res, 200, {});
    return;
  }
  const method = getAntigravityMethod(p);
  const providersJson = readProvidersJson();
  const isHybrid = providersJson.antigravityMode === 'hybrid';

  if (method === 'loadCodeAssist') {
    if (isHybrid) {
      await handleHybridHandshake(res, req, body, '/v1internal:loadCodeAssist', ensureAntigravityTier, mockAntigravityLoadCodeAssist);
      return;
    }
    sendJson(res, 200, await singleflight('ag_load_code_assist', 10000, async () => mockAntigravityLoadCodeAssist()));
    return;
  }
  if (method === 'onboardUser') {
    const onboardMock = () => ({
      name: 'operations/anybridge-onboard',
      done: true,
      response: {
        cloudaicompanionProject: { id: '', name: '', projectNumber: '0' },
        status: { statusCode: 'ONBOARDED', displayMessage: 'AnyBridge onboarding complete' },
      },
    });
    if (isHybrid) {
      await forwardToOfficialAntigravity(req, res, { body, onFailed: () => sendJson(res, 200, onboardMock()) });
      return;
    }
    sendJson(res, 200, onboardMock());
    return;
  }
  if (method === 'retrieveUserQuotaSummary' || method === 'retrieveUserQuota') {
    const { mockCreditsEnabled } = resolveAntigravityQuotaPolicy(providersJson);
    if (isHybrid) {
      await forwardToOfficialAntigravity(
        req,
        res,
        mockCreditsEnabled
          ? { body, onFailed: () => sendJson(res, 200, mockAntigravityUserQuotaSummary()) }
          : { body },
      );
      return;
    }
    if (!mockCreditsEnabled) {
      sendJson(res, 200, { userQuotaSummary: { quotas: [] } });
      return;
    }
    sendJson(res, 200, await singleflight('ag_user_quota_summary', 10000, async () => mockAntigravityUserQuotaSummary()));
    return;
  }
  if (method === 'fetchUserInfo') {
    if (isHybrid) {
      await handleHybridHandshake(res, req, body, '/v1internal:fetchUserInfo', ensureAntigravityTier, mockAntigravityUserInfo);
      return;
    }
    sendJson(res, 200, await singleflight('ag_user_info', 10000, async () => mockAntigravityUserInfo()));
    return;
  }
  if (method === 'fetchAdminControls') {
    if (isHybrid) {
      await handleHybridHandshake(res, req, body, '/v1internal:fetchAdminControls', ensureAntigravityAdminControls, mockAntigravityAdminControls);
      return;
    }
    sendJson(res, 200, await singleflight('ag_admin_controls', 10000, async () => mockAntigravityAdminControls()));
    return;
  }
  if (method === 'listExperiments') {
    if (isHybrid) {
      await handleHybridHandshake(res, req, body, '/v1internal:listExperiments', ensureAntigravityExperiments, mockAntigravityListExperiments);
      return;
    }
    sendJson(res, 200, await singleflight('ag_list_experiments', 10000, async () => mockAntigravityListExperiments()));
    return;
  }
  if (method === 'getCodeAssistGlobalUserSetting' || method === 'setUserSettings') {
    if (isHybrid) {
      await forwardToOfficialAntigravity(req, res, { body, onFailed: () => sendJson(res, 200, mockAntigravityUserSettings()) });
      return;
    }
    sendJson(res, 200, mockAntigravityUserSettings());
    return;
  }
  if (method === 'fetchAvailableModels') {
    const cacheKey = isHybrid ? `ag_fetch_models_hybrid:${antigravityAuthScopeKey(req)}` : 'ag_fetch_models_pure';
    const modelsPayload = await singleflight(cacheKey, 15000, async () => {
      let officialData = null;
      if (isHybrid && typeof fetchOfficialAntigravityModels === 'function') {
        try { officialData = await fetchOfficialAntigravityModels(req, body); } catch {}
      }
      return mergeAntigravityModelsResponse(officialData, readProvidersJson());
    });
    sendJson(res, 200, modelsPayload);
    return;
  }
  if (method === 'streamGenerateContent' || method === 'generateContent') {
    const reqData = (json.request && typeof json.request === 'object') ? json.request : json;
    const requestedModel = json.model || reqData.model || '';
    const customModel = resolveAntigravityCustomModel(requestedModel, providersJson);
    console.error(`[antigravity] ${method} requestedModel=${JSON.stringify(requestedModel)} resolved=${customModel ? customModel.upstreamModel : 'null'} topLevelKeys=${JSON.stringify(Object.keys(json))} customOverride=${JSON.stringify(json.customModelInfoOverride || reqData.customModelInfoOverride || null)}`);
    if (!customModel) {
      if (isHybrid) { await forwardToOfficialAntigravity(req, res, { body }); return; }
      const errMsg = `未找到模型 [${requestedModel}] 对应的 Provider 配置，请在 AnyBridge 中添加并启用该模型。`;
      if (method === 'streamGenerateContent') { writeAntigravityStreamError(res, { model: requestedModel }, errMsg); return; }
      sendJson(res, 400, { error: { code: 400, message: errMsg, status: 'INVALID_ARGUMENT' } });
      return;
    }
    const stream = method === 'streamGenerateContent';
    const pinned = buildAntigravityRouteFromCustomModel(customModel, requestedModel, loadProviders());
    if (pinned?.error && !customModel.isInternalDependency) {
      if (stream) { writeAntigravityStreamError(res, { model: requestedModel }, pinned.error); return; }
      sendJson(res, 400, { error: { code: 400, message: pinned.error, status: 'FAILED_PRECONDITION' } });
      return;
    }
    const baseCtx = buildAntigravityNormalizedCtx(attachScope, reqData, json, customModel.upstreamModel, { stream });
    const ctx = pinned?.route ? { ...baseCtx, pinnedRoute: pinned.route } : baseCtx;
    let result;
    try {
      result = await execute(ctx);
    } catch (e) {
      if (customModel?.isInternalDependency) {
        console.error(`[antigravity] internal dependency request failed: ${e?.message || String(e)}`);
        const empty = antigravityEnvelope({ candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }] });
        if (stream) {
          res.writeHead(200, cors({ 'content-type': 'text/event-stream; charset=utf-8' }));
          sse(res, null, empty);
          res.end();
        } else {
          sendJson(res, 200, empty);
        }
        return;
      }
      if (stream) { writeAntigravityStreamError(res, ctx, e?.message || String(e)); return; }
      throw e;
    }
    if (stream) {
      await sendAntigravityStream(ctx, res, result, customModel);
    } else {
      const payload = geminiResponsePayload(ctx, result);
      const hasToolCalls = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
      if (payload.candidates?.[0] && hasToolCalls) payload.candidates[0].finishReason = 'TOOL_CALL';
      sendJson(res, 200, antigravityEnvelope(payload), result?.extraHeaders || {});
    }
    return;
  }
  if (method === 'countTokens') {
    const requestedModel = json.model || json.request?.model || '';
    const customModel = resolveAntigravityCustomModel(requestedModel, providersJson);
    if (!customModel && isHybrid) { await forwardToOfficialAntigravity(req, res, { body }); return; }
    const source = json.request && typeof json.request === 'object' ? json.request : json;
    const targetModel = customModel?.upstreamModel || json.model || source.model || 'model';
    const pinned = customModel
      ? buildAntigravityRouteFromCustomModel(customModel, requestedModel, loadProviders())
      : null;
    const baseCtx = buildAntigravityNormalizedCtx(attachScope, source, json, targetModel);
    const ctx = pinned?.route ? { ...baseCtx, pinnedRoute: pinned.route } : baseCtx;
    let totalTokens = 0;
    try {
      totalTokens = await executeGeminiCountTokens(ctx);
    } catch {
      totalTokens = estimateTokens(ctx.messages, ctx.system) || 1;
    }
    sendJson(res, 200, { totalTokens: totalTokens || 1 });
    return;
  }
  if (isHybrid) {
    const raw = await fetchOfficialAntigravityRaw(req, body, p);
    if (raw) {
      res.writeHead(raw.statusCode, cors({ 'content-type': raw.contentType || 'application/json; charset=utf-8', 'content-length': raw.body.length }));
      res.end(raw.body);
    } else {
      sendJson(res, 200, {});
    }
    return;
  }
  sendJson(res, 200, {});
}

export async function handleLocalProxyRequest(req, res, body) {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors()); res.end(); return; }
  const p = pathnameOf(req);
  if (req.method === 'GET' && (p === '/' || p === '/health' || p === '/status' || p === '/v1')) {
    sendJson(res, 200, { status: true, system_name: 'AnyBridge', message: 'AnyBridge local proxy server is running', version: '0.5.2' });
    return;
  }
  const auth = validateAuth(req);
  if (!auth.ok) {
    if (pathnameOf(req).startsWith('/v1beta/')) sendGeminiError(res, auth.status, auth.message, auth.status === 401 ? 'UNAUTHENTICATED' : 'FAILED_PRECONDITION');
    else sendError(res, auth.status, auth.message, 'authentication_error');
    return;
  }
  const scope = proxyScopeForPath(p);
  const tracker = createTracker({ client: 'local-proxy', route: 'local-proxy' });
  res.__byokTracker = tracker;
  const reqAbortCtrl = new AbortController();
  const onReqClose = () => {
    if (!res.writableEnded) reqAbortCtrl.abort();
  };
  if (typeof res.once === 'function') res.once('close', onReqClose);
  const attachScope = (ctx) => {
    ctx.proxyRouteScope = scope;
    ctx.__tracker = tracker;
    ctx.signal = reqAbortCtrl.signal;
    return ctx;
  };
  if (req.method === 'GET' && (p === '/v1/models' || p === '/models' || p === '/codex/v1/models' || p === '/anthropic/v1/models' || p === '/v1beta/models' || p === '/claude-desktop/v1/models' || p === '/claude-desktop/models')) {
    handleModels(req, res);
    return;
  }
  const geminiSingleModel = req.method === 'GET' ? p.match(/^\/(?:v1beta|v1)\/models\/(?:models\/)?([^/:]+)$/) : null;
  if (geminiSingleModel) { handleGeminiModelInfo(decodeURIComponent(geminiSingleModel[1]), res, scope); return; }

  let json;
  try {
    json = body && body.length ? JSON.parse(body.toString('utf8')) : {};
  } catch (e) {
    const message = `请求 JSON 解析失败: ${e.message}`;
    if (p.startsWith('/v1beta/') || isGeminiGenerateContentPath(p)) sendGeminiError(res, 400, message, 'INVALID_ARGUMENT');
    else if (p.startsWith('/anthropic/') || p.startsWith('/claude-desktop') || p.endsWith('/messages')) sendAnthropicError(res, 400, message);
    else sendError(res, 400, message);
    return;
  }
  if (p === '/__byok/web-search/test') {
    const query = String(json.query || '').trim();
    if (!query) { sendError(res, 400, '测试搜索 query 不能为空'); return; }
    try {
      const result = await executeSearchWithFailover([json.source || {}], query, Number(json.maxResults) || 3);
      sendJson(res, 200, { results: result.results, source: result.source, attempts: result.attempts });
    } catch (e) {
      sendError(res, 502, e.message || '搜索源测试失败', 'search_source_error');
    }
    return;
  }
  if (p.endsWith('/messages/count_tokens')) { handleCountTokens(json, res); return; }

  try {
    if (p === '/v1/chat/completions' || p === '/chat/completions' || p === '/codex/v1/chat/completions') {
      const ctx = attachScope(normalizeRequest('openai', json));
      const result = await execute(ctx);
      if (result.stream === true) { await sendOpenAIChatStream(ctx, res, result); return; }
      sendOpenAIChat(ctx, res, result);
      return;
    }
    if (p === '/v1/responses' || p === '/responses' || p === '/codex/v1/responses') {
      const ctx = attachScope(normalizeRequest('responses', json));
      await sendOpenAIResponses(ctx, res, await execute(ctx));
      return;
    }
    if (p === '/claude-desktop/v1/messages' || p === '/claude-desktop/messages') {
      const mapped = mapClaudeDesktopModel(json.model);
      if (mapped.error) { sendAnthropicError(res, 400, mapped.error); return; }
      json.model = mapped.model;
      const ctx = attachScope(normalizeRequest('anthropic', json));
      ctx.originalModel = mapped.original;
      ctx.pinnedRoute = mapped.route || null;
      await sendAnthropic(ctx, res, await execute(ctx));
      return;
    }
    if (p === '/v1/messages' || p === '/messages' || p === '/anthropic/v1/messages' || p === '/anthropic/messages') {
      const ctx = attachScope(normalizeRequest('anthropic', json));
      await sendAnthropic(ctx, res, await execute(ctx));
      return;
    }
    if (isGeminiGenerateContentPath(p)) {
      if (req.method !== 'POST') {
        sendGeminiError(res, 405, `Gemini ${geminiMethodFromPath(p)} 端点仅支持 POST`, 'FAILED_PRECONDITION');
        return;
      }
      const method = geminiMethodFromPath(p);
      if (method === 'countTokens') {
        const source = json.generateContentRequest && typeof json.generateContentRequest === 'object'
          ? { ...json.generateContentRequest, model: geminiModelFromPath(p) }
          : { ...json, model: geminiModelFromPath(p) };
        const ctx = attachScope(normalizeRequest('gemini', source));
        const totalTokens = await executeGeminiCountTokens(ctx);
        sendJson(res, 200, { totalTokens });
        return;
      }
      const stream = method === 'streamGenerateContent';
      const asSse = new URL(req.url, 'http://localhost').searchParams.get('alt') === 'sse';
      const ctx = attachScope(normalizeRequest('gemini', { ...json, model: geminiModelFromPath(p), stream }));
      const result = await execute(ctx);
      if (stream) await sendGeminiStream(ctx, res, result, asSse);
      else sendGemini(ctx, res, result);
      return;
    }
    if (isAntigravityPath(p)) {
      await handleAntigravityRequest(req, res, body, p, json, attachScope);
      return;
    }
    sendError(res, 404, `未知本地网关路径: ${p}`);
  } catch (e) {
    tracker.finish();
    if (e.upstreamResponse) {
      sendRaw(res, e.upstreamResponse.statusCode || e.status || 502, e.upstreamResponse.body, e.upstreamResponse.headers);
      return;
    }
    const status = Number(e.status) || 502;
    const type = e.type || 'upstream_error';
    const message = e.message || String(e);
    if (p.startsWith('/anthropic/') || p.startsWith('/claude-desktop') || p.endsWith('/messages') || p.endsWith('/messages/count_tokens')) {
      sendAnthropicError(res, status, message, type);
      return;
    }
    if (isAntigravityPath(p)) {
      sendJson(res, status >= 400 && status < 600 ? status : 502, { error: { code: status, message, status: type } });
      return;
    }
    if (p.startsWith('/v1beta/') || isGeminiGenerateContentPath(p)) {
      const geminiStatus = type === 'authentication_error' ? 'UNAUTHENTICATED'
        : (type === 'permission_error' ? 'PERMISSION_DENIED'
          : (type === 'not_found_error' ? 'NOT_FOUND'
            : (type === 'rate_limit_error' ? 'RESOURCE_EXHAUSTED'
              : (type === 'not_implemented' || status === 501 ? 'UNIMPLEMENTED'
                : (status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT')))));
      sendGeminiError(res, status, message, geminiStatus);
      return;
    }
    sendError(res, status, message, type);
  }
}
