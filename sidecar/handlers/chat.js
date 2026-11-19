// handlers/chat.js — GetChatMessage handler (orchestrator)
//
// Parses Windsurf's protobuf request → resolves slot & target → streams back
// Connect-RPC protobuf using the exa.api_server_pb schema.

import crypto from 'node:crypto';
import { parseGetChatMessageRequest } from './parse-request.js';
import { getInjectedByUid, getSlot, loadModelMapConfig, loadProviders, resolveTarget } from '../provider-pool.js';
import { RETRY_CAP_MS } from './chat/utils.js';
import { createTargetAttemptRunner } from '../lib/attempt-runner.js';
import { getRuntimeModelSlotStatus } from '../rename-models.js';
import { preprocessImagesWithThirdPartyVision } from '../vision-fallback.js';
import {
  clampEffortLevel,
  describeThinking,
  effortVocabForConn,
  resolveThinkingEffort,
} from '../lib/thinking-effort.js';
import {
  cooldownPolicyFromEnhancement,
  filterTargets,
  markFailure,
  markSuccess,
  targetKey,
} from '../lib/provider-cooldown.js';
import { streamSearchAgentLoop } from './chat/search-agent.js';
import { streamAnthropic, streamGemini, streamOpenAI } from './chat/streaming.js';
import {
  applyChatToolEnhancement,
  applyChatToolInjection,
  applySystemPromptEnhancement,
  checkChatRateLimit,
  connectCodeForFailures,
  envReasoningEffort,
  extractModelId,
  failureLogLine,
  getServiceTier,
  logEnhancedChatRequest,
  messageHasImage,
  providerFailureMessage,
  retryPolicyFromEnhancement,
  sendTerminalError,
} from './chat/utils.js';

export function shouldIntercept(body, headers) {
  const modelId = extractModelId(body, headers);
  const slot = getSlot(modelId);
  if (slot) return true;
  if (getInjectedByUid(modelId)) return true;
  return Boolean(getRuntimeModelSlotStatus(modelId));
}

export function handleGetChatMessage(req, res, body, tracker) {
  if (!tracker) throw new Error('[chat] handleGetChatMessage requires a request tracker');
  res.__byokTracker = tracker;
  let { systemPrompt, messages, tools, toolChoice, requestedModel } =
    parseGetChatMessageRequest(body, req.headers);

  const messageId = crypto.randomUUID();
  tracker.bindRequestId(messageId);
  tracker.requestedModel = requestedModel;
  let slot = getSlot(requestedModel);
  const injected = slot ? null : getInjectedByUid(requestedModel);
  const runtimeSlot = slot || injected ? null : getRuntimeModelSlotStatus(requestedModel);

  if (injected && injected.status !== 'configured') {
    const label = injected.label || requestedModel;
    const msg = `模型槽位「${label}」已解锁但尚未配置 BYOK 映射。请在「模型槽位管理」中选择供应商并填写 model 字段。`;
    console.warn(`  ⚠️  ${msg}`);
    tracker.reject('unconfigured', msg);
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  if (runtimeSlot && runtimeSlot.status === 'unconfigured') {
    const label = runtimeSlot.label || requestedModel;
    const msg = `模型槽位「${label}」已解锁但尚未配置 BYOK 映射。请在「模型槽位管理」中选择供应商并填写 model 字段。`;
    console.warn(`  ⚠️  ${msg}`);
    tracker.reject('unconfigured', msg);
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  if (injected) {
    const injectedSupportsImages = injected.supportsImages !== false;
    slot = {
      modelUid: injected.modelUid,
      displayName: injected.label,
      supportsImages: injectedSupportsImages,
      useThirdPartyVision: !injectedSupportsImages,
      targets: [{
        providerId: injected.providerId,
        model: injected.model,
        apiFormat: injected.apiFormat,
        apiPath: injected.apiPath,
        unlock: injected.unlock,
        thinkingEffort: injected.thinkingEffort,
      }],
      routeKind: 'injected',
    };
  }

  if (!slot || !slot.targets || slot.targets.length === 0) {
    const label = slot?.displayName || requestedModel;
    const msg = `模型映射「${label}」已启用但尚未配置目标供应商。请在「模型映射」中编辑该行并添加供应商/model。`;
    console.warn(`  ⚠️  ${msg}`);
    tracker.reject('unconfigured', msg);
    sendTerminalError(res, messageId, msg, 'invalid_argument');
    return;
  }

  const providers = loadProviders();
  const modelMapConfig = loadModelMapConfig();
  const enhancement = modelMapConfig?.enhancement || {};
  const searchModels = modelMapConfig?.searchModels || {};
  const autoRoutingEnabled = enhancement.autoRouting !== false;
  const retryPolicy = retryPolicyFromEnhancement(enhancement);
  const serviceTier = getServiceTier(requestedModel);

  systemPrompt = applySystemPromptEnhancement(systemPrompt, enhancement);
  const toolEnhancement = applyChatToolEnhancement(tools, toolChoice, enhancement);
  if (toolEnhancement.error) {
    console.warn(`  ⚠️  ${toolEnhancement.error}`);
    tracker.reject('invalid-tool', toolEnhancement.error);
    sendTerminalError(res, messageId, toolEnhancement.error, 'invalid_argument');
    return;
  }
  tools = toolEnhancement.tools;
  toolChoice = toolEnhancement.toolChoice;

  if (enhancement.rateLimitEnabled === true && enhancement.rateLimitRpm > 0) {
    const allowed = checkChatRateLimit(requestedModel, enhancement.rateLimitRpm);
    if (!allowed) {
      const msg = `请求频率超限：${enhancement.rateLimitRpm} RPM`;
      console.warn(`  ⚠️  ${msg}`);
      tracker.reject('rate-limit', msg);
      sendTerminalError(res, messageId, msg, 'resource_exhausted');
      return;
    }
  }
  if (enhancement.requestLogging === true) {
    logEnhancedChatRequest({
      phase: 'request',
      model: requestedModel,
      systemChars: systemPrompt.length,
      messageCount: messages.length,
      toolCount: Array.isArray(tools) ? tools.length : 0,
    });
  }

  const routeLabel = slot.routeKind === 'injected' ? 'Managed slot' : 'Slot';
  console.log(`  🧠 ${routeLabel}: ${requestedModel} (${slot.displayName || '原名'}) → ${slot.targets.length} target(s)`);
  console.log(`  📝 System: ${systemPrompt.length} chars  💬 Messages: ${messages.length}${tools ? `  🔧 Tools: ${tools.length}` : ''}`);

  const hasImages = messages.some(messageHasImage);
  const cooldownPolicy = cooldownPolicyFromEnhancement(enhancement);
  const routed = autoRoutingEnabled
    ? filterTargets(slot.targets, cooldownPolicy)
    : { targets: [slot.targets[0]], cooling: [], allCooling: false };
  const routingTargets = routed.targets;
  if (!autoRoutingEnabled && slot.targets.length > 1) {
    console.log(`  🧭 模型自动路由已关闭：只使用第 1 个目标，忽略其余 ${slot.targets.length - 1} 个备用目标`);
  }
  if (routed.cooling.length) {
    const lines = routed.cooling.map(c => `${c.target.providerId}${c.target.model ? `/${c.target.model}` : ''}(剩 ${Math.ceil(c.remainingMs / 1000)}s)`);
    console.warn(`  🧊 跳过 ${routed.cooling.length} 个冷却中的目标: ${lines.join(', ')}`);
  }
  if (routed.allCooling) {
    const minWait = Math.ceil(Math.min(...routed.cooling.map(c => c.remainingMs)) / 1000);
    const msg = `模型「${slot.displayName || requestedModel}」的所有上游目标均在冷却期内（最短剩余 ${minWait} 秒解冻），按策略直接阻断报错。`;
    console.error(`  ❌ ${msg}`);
    tracker.reject('cooldown', msg);
    sendTerminalError(res, messageId, msg, 'resource_exhausted');
    return;
  }
  if (hasImages) {
    const imgCount = messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'image').length : 0), 0);
    const sampleBlock = messages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'));
    const sampleImg = sampleBlock ? sampleBlock.content.find(b => b.type === 'image') : null;
    const dataLen = sampleImg?.source?.data?.length || 0;
    const mediaType = sampleImg?.source?.media_type || 'unknown';
    console.log(`  🖼️  Image request detected: ${imgCount} image(s), data_len=${dataLen}, media_type=${mediaType}`);
  }

  let idx = 0;
  const errors = [];
  const failures = [];
  function rememberFailure(failure) {
    failures.push(failure);
    errors.push(failureLogLine(failure));
  }
  let currentApiReq = null;
  let retryTimer = null;
  let clientClosed = false;
  let currentAttemptKey = null;
  let currentAttemptFailed = false;
  res.on('close', () => {
    clientClosed = !res.writableEnded;
    if (clientClosed) {
      tracker.abort('client closed');
      tracker.finish();
    }
    if (!clientClosed && currentAttemptKey && !currentAttemptFailed) {
      markSuccess(currentAttemptKey);
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (clientClosed && currentApiReq && !currentApiReq.destroyed) {
      console.log(`  🔌 客户端断开，中止上游请求`);
      currentApiReq.destroy();
    }
  });

  function attemptNext() {
    if (clientClosed || res.writableEnded) return;
    if (idx >= routingTargets.length) {
      const label = routingTargets.length > 1 ? `所有 ${routingTargets.length} 个目标均失败` : '目标失败';
      console.error(`  ❌ ${label}: ${errors.join(' | ')}`);
      tracker.fail('failover', errors.join(' | '));
      if (!res.writableEnded) {
        sendTerminalError(res, messageId, providerFailureMessage(failures), connectCodeForFailures(failures));
      }
      return;
    }

    const target = routingTargets[idx];
    let conn = resolveTarget(target, providers);
    idx++;
    currentAttemptKey = targetKey(target);
    currentAttemptFailed = false;

    if (conn.error) {
      const hasNextTarget = idx < routingTargets.length;
      console.warn(`  ⚠️  目标#${idx} ${target.providerId} 跳过: ${conn.error}${hasNextTarget ? ' → 切换下一个' : ''}`);
      rememberFailure({
        providerId: target.providerId,
        model: target.model,
        reason: conn.error,
      });
      return attemptNext();
    }

    if (hasImages && conn.capabilities?.vision === false) {
      console.warn(`  ⚠️  目标#${idx} ${conn.providerName} 未标记支持 Vision，但仍尝试转发（探测可能误报）`);
    }

    const routeMode = conn.unlockKind
      ? `${conn.format}/${conn.unlockKind}`
      : (conn.routeSource && conn.routeSource !== 'target-apiFormat' ? `${conn.format}/${conn.routeSource}` : conn.format);
    const effortSupported = conn.format === 'anthropic' || conn.format === 'openai' || conn.format === 'gemini';
    const envEffort = envReasoningEffort();
    const envLevel = envEffort && clampEffortLevel(envEffort, effortVocabForConn(conn));
    const thinking = !effortSupported ? null
      : (envLevel ? { mode: 'level', level: envLevel, source: 'env' } : resolveThinkingEffort(target, requestedModel, conn));
    console.log(`  ➡️  目标#${idx}: ${conn.providerName} (${routeMode}) → ${conn.model}${conn.capabilities?.gzip ? ' [gzip]' : ''}${thinking ? ` [effort=${describeThinking(thinking)}${thinking.source === 'config' ? '' : `/${thinking.source}`}]` : ''}`);
    tracker.beginAttempt({ provider: conn.providerName, providerId: conn.providerId, model: conn.model });

    const sys = systemPrompt;
    const targetStartedAt = Date.now();
    const attemptRunner = createTargetAttemptRunner({
      conn,
      policy: retryPolicy,
      tracker,
      startedAt: targetStartedAt,
      capToRemaining: false,
      capMsOverride: RETRY_CAP_MS,
    });
    let mmProcessedMessages = null;
    let mmConversionCount = 0;

    const startTargetRequest = async () => {
      retryTimer = null;
      if (clientClosed || res.writableEnded) return;

      let effectiveMessages = messages;
      const imageFallbackEnabled = modelMapConfig?.enhancement?.imageFallback !== false;
      const configuredVisionModels = modelMapConfig?.visionModels?.imageModels || [];
      const thirdPartyVisionEnabled = hasImages
        && slot.useThirdPartyVision === true
        && imageFallbackEnabled;
      if (thirdPartyVisionEnabled) {
        if (configuredVisionModels.length === 0) {
          const msg = `槽位「${slot.displayName || requestedModel}」已启用第三方图片理解，但网关增强里没有配置图片理解模型。`;
          console.error(`  ❌ ${msg}`);
          tracker.fail('vision-config', msg);
          sendTerminalError(res, messageId, msg, 'invalid_argument');
          return;
        }
        const targetMessages = mmProcessedMessages || messages;
        try {
          const result = await preprocessImagesWithThirdPartyVision(
            targetMessages,
            configuredVisionModels,
            providers,
            {
              requestId: messageId,
              requestedModel,
              slotModelUid: slot.modelUid || requestedModel,
              slotDisplayName: slot.displayName || requestedModel,
              visionOptions: {
                maxTokens: modelMapConfig?.enhancement?.visionMaxTokens,
                contextMode: modelMapConfig?.enhancement?.visionContextMode,
                contextMaxChars: modelMapConfig?.enhancement?.visionContextMaxChars,
                multiImageMode: modelMapConfig?.enhancement?.visionMultiImageMode,
                batchSize: modelMapConfig?.enhancement?.visionBatchSize,
              },
            },
          );
          if (result.conversions.length > 0) {
            effectiveMessages = result.messages;
            mmProcessedMessages = result.messages;
            mmConversionCount = result.conversions.length;
            const chain = result.conversions
              .map(c => `${c.providerName}/${c.model}`)
              .join(', ');
            console.log(`  👁️  第三方图片理解: ${mmConversionCount} 张图片 → 文本描述 (${chain})`);
          }
        } catch (e) {
          const msg = `第三方图片理解失败：${e.message}`;
          console.error(`  ❌ ${msg}`);
          tracker.fail('vision', msg);
          sendTerminalError(res, messageId, msg, 'unavailable');
          return;
        }
      }

      const onFailover = (reason, meta = {}) => {
        if (clientClosed || res.writableEnded) return;
        const decision = attemptRunner.evaluateFailure({
          statusCode: meta.statusCode,
          code: meta.code,
          headers: meta.headers,
          reason,
          headersSent: res.headersSent,
          includeReasonInRotationNote: false,
        });
        const retryTargetAsync = (label) => {
          startTargetRequest().catch((err) => {
            console.error(`  ❌ ${label} 异常: ${err.message}`);
            if (!res.writableEnded) {
              tracker.fail('internal', err.message);
              sendTerminalError(res, messageId, `BYOK 请求异常：${err.message}`, 'unavailable');
            }
          });
        };
        if (decision.action === 'rotate-key') {
          conn = decision.conn;
          console.warn(`  🔑 ${conn.providerName} 遇到 ${meta.statusCode}，切换备用密钥 (${decision.keyIndex + 1}/${decision.totalKeys})${decision.waitMs ? `，等待 ${decision.waitMs}ms` : ''}`);
          if (decision.waitMs > 0) {
            retryTimer = setTimeout(() => retryTargetAsync('key-rotation retry'), decision.waitMs);
          } else {
            retryTargetAsync('key-rotation retry');
          }
          return;
        }
        if (decision.action === 'micro-backoff' || decision.action === 'retry') {
          console.warn(`  ⏳ ${conn.providerName} 失败(${reason})，${decision.waitMs}ms 后重试 ${decision.retryCount}/${decision.maxRetries}`);
          retryTimer = setTimeout(() => retryTargetAsync('retry'), decision.waitMs);
          return;
        }

        const hasNextTarget = idx < routingTargets.length;
        console.warn(`  ⚠️  ${conn.providerName} 失败(${reason})${hasNextTarget ? ' → 切换下一个' : ''}`);
        currentAttemptFailed = true;
        tracker.endAttempt({ status: 'failed', statusCode: meta.statusCode ?? null, error: reason });
        if (routingTargets.length > 1) {
          markFailure(currentAttemptKey, {
            statusCode: meta.statusCode,
            code: meta.code,
            reason,
            body: meta.body,
            providerName: conn.providerName,
            model: conn.model,
          }, cooldownPolicy);
        }
        rememberFailure({
          providerId: conn.providerId,
          providerName: conn.providerName,
          model: conn.model,
          routeMode,
          apiPath: conn.apiPath,
          reason,
          statusCode: meta.statusCode,
          code: meta.code,
          body: meta.body,
        });
        attemptNext();
      };

      const toolInjection = applyChatToolInjection(tools, conn, enhancement, searchModels);
      if (toolInjection.searchInjection?.mode === 'missing-search-source'
          || toolInjection.searchInjection?.mode === 'unsupported-gemini-native') {
        const reason = toolInjection.searchInjection.reason || '当前目标不支持联网搜索';
        const hasNextTarget = idx < routingTargets.length;
        console.warn(`  ⚠️  ${conn.providerName} 跳过: ${reason}${hasNextTarget ? ' → 切换下一个' : ''}`);
        currentAttemptFailed = true;
        rememberFailure({
          providerId: conn.providerId,
          providerName: conn.providerName,
          model: conn.model,
          routeMode,
          apiPath: conn.apiPath,
          reason,
        });
        attemptNext();
        return;
      }
      const targetTools = toolInjection.tools;

      const opts = {
        systemPrompt: sys,
        messages: effectiveMessages,
        tools: targetTools,
        toolChoice,
        resolvedModel: conn.model,
        requestedModel,
        serviceTier,
        thinking,
        messageId,
        conn,
        enhancement,
        onFailover,
        schemaCompatRetry: false,
        bindActiveReq: (r) => { currentApiReq = r; },
        searchModels,
        searchInjection: toolInjection.searchInjection,
      };

      if (toolInjection.searchInjection?.mode === 'generic') {
        await streamSearchAgentLoop(req, res, opts);
      } else {
        currentApiReq = await (conn.format === 'openai'
          ? streamOpenAI(req, res, opts)
          : (conn.format === 'gemini'
            ? streamGemini(req, res, opts)
            : streamAnthropic(req, res, opts)));
      }
    };

    startTargetRequest().catch(err => {
      console.error(`  ❌ startTargetRequest 异常: ${err.message}`);
      if (res.headersSent) {
        if (!res.writableEnded) {
          tracker.fail('internal', err.message);
          sendTerminalError(res, messageId, `BYOK 请求异常：${err.message}`, 'unavailable');
        }
        return;
      }
      currentAttemptFailed = true;
      rememberFailure({
        providerId: conn.providerId,
        providerName: conn.providerName,
        model: conn.model,
        routeMode,
        apiPath: conn.apiPath,
        reason: `startTargetRequest 异常: ${err.message}`,
      });
      attemptNext();
    });
  }

  attemptNext();
}
