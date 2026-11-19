// platforms/real_config.js — split from 55-platforms.js
let currentViewingRealConfigPlatform = 'codex';

async function openPlatformRealConfigModal(platform = 'codex') {
  currentViewingRealConfigPlatform = platform;
  const modal = document.getElementById('platform-real-config-modal');
  if (!modal) return;

  const titleMap = {
    'codex': { title: '配置文件实际内容 · config.toml', file: '~/.codex/config.toml' },
    'claude-code': { title: '配置文件实际内容 · settings.json', file: '~/.claude/settings.json' },
    'opencode': { title: '配置文件实际内容 · opencode.json', file: '~/.config/opencode/opencode.json' },
    'grok': { title: '配置文件实际内容 · config.toml', file: '~/.grok/config.toml' },
    'pi': { title: '配置文件实际内容 · models.json', file: '~/.pi/agent/models.json' },
    'hermes': { title: '配置文件实际内容 · config.yaml', file: '~/.hermes/config.yaml' },
    'deepseek-harness': { title: '配置文件实际内容 · settings.yaml', file: '~/.dsh/settings.yaml' },
    'claude-desktop': { title: '配置文件实际内容 · claude_desktop_config.json', file: 'Claude-3p/claude_desktop_config.json' },
    // Antigravity 双端与其余平台补齐：后端 read/write_platform_config_file 走
    // Platform::from_id，本就支持这些 id，此前只是前端标题映射缺失。
    'antigravity': { title: '配置文件实际内容 · settings.json', file: '%APPDATA%\\Antigravity\\User\\settings.json' },
    'antigravity-ide': { title: '配置文件实际内容 · settings.json', file: '%APPDATA%\\Antigravity IDE\\User\\settings.json' },
    'codebuddy': { title: '配置文件实际内容 · settings.json', file: '~/.codebuddy/settings.json' },
    'workbuddy': { title: '配置文件实际内容 · settings.json', file: '~/.workbuddy/settings.json' },
    'zcode': { title: '配置文件实际内容 · settings.json', file: '~/.zcode/settings.json' }
  };

  const meta = titleMap[platform] || { title: `配置文件实际内容 · ${platform}`, file: '本地磁盘配置文件' };
  const titleEl = document.getElementById('platform-real-config-modal-title');
  const pathEl = document.getElementById('platform-real-config-modal-path');
  if (titleEl) titleEl.textContent = meta.title;
  if (pathEl) pathEl.textContent = `文件路径：${meta.file}`;

  modal.classList.add('active');
  await reloadPlatformRealConfigModal(false);
}

function closePlatformRealConfigModal() {
  document.getElementById('platform-real-config-modal')?.classList.remove('active');
}

async function reloadPlatformRealConfigModal(notify = true) {
  await loadPlatformRealConfigFile(currentViewingRealConfigPlatform, 'platform-real-config-modal-textarea', notify);
}

function copyPlatformRealConfigModal() {
  copyRawConfigText('platform-real-config-modal-textarea', `${currentViewingRealConfigPlatform} 配置文件内容`);
}

async function savePlatformRealConfigModal() {
  const textarea = document.getElementById('platform-real-config-modal-textarea');
  if (!textarea) return;
  const content = textarea.value;
  const saveBtn = document.getElementById('platform-real-config-modal-save-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = loadingHtml('保存中…');
  }
  try {
    const ok = await invoke('write_platform_config_file', {
      platform: currentViewingRealConfigPlatform,
      content,
    });
    if (ok) {
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已成功保存并写回 ${currentViewingRealConfigPlatform} 磁盘配置文件`, 'success');
      } else {
        showCustomAlert('已成功保存并写回磁盘配置文件。', '保存成功', 'success');
      }
      closePlatformRealConfigModal();
      if (typeof refreshPlatforms === 'function') {
        refreshPlatforms();
      }
    }
  } catch (e) {
    console.error(`[platforms] 写入配置文件失败:`, e);
    showCustomAlert(String(e), '保存失败', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存修改';
    }
  }
}

async function loadPlatformRealConfigFile(platform, textareaId, notify = false) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return false;
  try {
    const content = await invoke('read_platform_config_file', { platform });
    if (content && content.trim()) {
      textarea.value = content;
      if (notify && typeof showBottomToast === 'function') {
        showBottomToast(`已从磁盘重新载入 ${platform} 配置文件原文`, 'success');
      }
      return true;
    } else {
      if (notify && typeof showBottomToast === 'function') {
        showBottomToast(`磁盘上尚未检测到 ${platform} 配置文件，已呈现预设模版`, 'info');
      }
    }
  } catch (e) {
    console.warn(`[platforms] 读取 ${platform} 磁盘配置文件失败:`, e);
    if (notify && typeof showCustomAlert === 'function') {
      showCustomAlert(String(e), '读取配置文件失败', 'error');
    }
  }
  return false;
}

function copyRawConfigText(textareaId, label = '配置文本') {
  const el = document.getElementById(textareaId);
  if (!el || !el.value.trim()) {
    showCustomAlert('暂无可复制的内容。', '提示', 'info');
    return;
  }
  const text = el.value;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已复制 ${label} 到剪贴板`, 'success');
      } else {
        showCustomAlert(`已复制 ${label} 到剪贴板。`, '复制成功', 'success');
      }
    }).catch(() => {
      el.select();
      document.execCommand('copy');
      showCustomAlert(`已复制 ${label} 到剪贴板。`, '复制成功', 'success');
    });
  } else {
    el.select();
    document.execCommand('copy');
    showCustomAlert(`已复制 ${label} 到剪贴板。`, '复制成功', 'success');
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openPlatformRealConfigModal = openPlatformRealConfigModal;
  g.closePlatformRealConfigModal = closePlatformRealConfigModal;
  g.reloadPlatformRealConfigModal = reloadPlatformRealConfigModal;
  g.copyPlatformRealConfigModal = copyPlatformRealConfigModal;
  g.savePlatformRealConfigModal = savePlatformRealConfigModal;
  g.loadPlatformRealConfigFile = loadPlatformRealConfigFile;
  g.copyRawConfigText = copyRawConfigText;
})(globalThis);
