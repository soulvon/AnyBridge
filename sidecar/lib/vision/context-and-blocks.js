export function clipContextText(text, maxChars, labelMaxChars = maxChars) {
  const value = String(text || '').trim();
  if (maxChars <= 0) return '';
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[上下文已按 visionContextMaxChars=${labelMaxChars} 截断]`;
}

export function roleLabel(role) {
  if (role === 'assistant') return '助手';
  if (role === 'system') return '系统';
  return '用户';
}

export function buildPriorContext(messages, messageIndex, mode, maxChars, { textFromMessage, textPreview }) {
  if (mode === 'current') return '';
  const rows = [];
  const source = Array.isArray(messages) ? messages.slice(0, messageIndex) : [];
  for (const msg of source) {
    const rawText = textFromMessage(msg);
    const text = mode === 'full' ? String(rawText || '').trim() : textPreview(rawText, 1200);
    if (!text) continue;
    rows.push(`${roleLabel(msg.role)}：${text}`);
  }
  if (!rows.length) return '';
  const title = mode === 'full'
    ? '以下是图片之前的完整文本上下文（不含图片二进制）：'
    : '以下是图片之前的最近文本上下文（由历史文本摘取，供图片理解聚焦）：';
  if (mode === 'summary') {
    const picked = [];
    let size = title.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (size + row.length + 2 > maxChars && picked.length) break;
      picked.unshift(row);
      size += row.length + 2;
    }
    return clipContextText(`${title}\n${picked.join('\n')}`, maxChars);
  }
  return clipContextText(`${title}\n${rows.join('\n')}`, maxChars);
}

export function visionContextForMessage(messages, messageIndex, userText, options, deps) {
  const mode = options.contextMode || 'current';
  const prior = buildPriorContext(messages, messageIndex, mode, options.contextMaxChars, deps);
  const current = String(userText || '').trim();
  if (!prior) return current;
  const currentBlock = `当前用户围绕图片提出的问题是：\n${current || '(当前消息没有额外文字)'}`;
  const maxChars = options.contextMaxChars;
  const joined = `${prior}\n\n${currentBlock}`;
  if (joined.length <= maxChars) return joined;
  const priorBudget = maxChars - currentBlock.length - 2;
  if (priorBudget <= 0) {
    return `${currentBlock}\n[前文因 visionContextMaxChars=${maxChars} 过小未发送给图片理解模型]`;
  }
  return `${clipContextText(prior, priorBudget, maxChars)}\n\n${currentBlock}`;
}

export function imageDescriptionBlock({ ref, description, imageHash, messageIndex, blockIndex, cached, seenInConversation, textBlockType = 'text' }) {
  const seen = seenInConversation ? '；此前在本会话出现过，本次复用已有描述' : '';
  const cache = cached ? '；未重新调用图片理解模型' : '';
  return {
    type: textBlockType,
    text: `\n\n[第三方图片理解：图片 #${ref}]\n来源：第 ${messageIndex + 1} 条用户消息，第 ${blockIndex + 1} 张图片；imageHash=${imageHash}${seen}${cache}\n内容：\n${description}`,
  };
}

export function repeatedImageBlock({ ref, imageHash, messageIndex, blockIndex, textBlockType = 'text' }) {
  return {
    type: textBlockType,
    text: `\n\n[第三方图片理解：图片 #${ref}]\n来源：第 ${messageIndex + 1} 条用户消息，第 ${blockIndex + 1} 张图片；imageHash=${imageHash}\n这张图片与本次请求中前面出现的图片 #${ref} 相同，沿用上方描述。`,
  };
}

export function formatRefList(refs = []) {
  const unique = [...new Set(refs)].filter(ref => Number.isFinite(ref));
  if (unique.length === 0) return '';
  if (unique.length === 1) return `#${unique[0]}`;
  const contiguous = unique.every((ref, idx) => idx === 0 || ref === unique[idx - 1] + 1);
  return contiguous ? `#${unique[0]}-#${unique[unique.length - 1]}` : unique.map(ref => `#${ref}`).join('、');
}

export function batchImageDescriptionBlock({ refs, description, imageHashes, messageIndex, blockIndexes, cached, textBlockType = 'text' }) {
  const refLabel = formatRefList(refs);
  const cache = cached ? '；未重新调用图片理解模型' : '';
  const sources = blockIndexes.map((idx, i) => `图片 #${refs[i]}=第 ${messageIndex + 1} 条用户消息，第 ${idx + 1} 张图片，imageHash=${imageHashes[i]}`).join('；');
  return {
    type: textBlockType,
    text: `\n\n[第三方图片理解：批量图片 ${refLabel}]\n来源：${sources}${cache}\n内容：\n${description}`,
  };
}

export function batchImageReferenceBlock({ ref, batchRefs, imageHash, messageIndex, blockIndex, textBlockType = 'text' }) {
  const refLabel = formatRefList(batchRefs);
  return {
    type: textBlockType,
    text: `\n\n[第三方图片理解：图片 #${ref}]\n来源：第 ${messageIndex + 1} 条用户消息，第 ${blockIndex + 1} 张图片；imageHash=${imageHash}\n这张图片已包含在上方批量图片 ${refLabel} 的描述中。`,
  };
}

export function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

