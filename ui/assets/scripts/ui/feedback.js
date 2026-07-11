/**
 * ui/feedback.js — alert / toast / confirm / prompt（P4 共享层）
 */
export function showCustomAlert(message, title, iconType) {
  title = title || '提示';
  iconType = iconType || 'info'; // info | warn | error | success

  const modal = document.getElementById('custom-alert-modal');
  const titleEl = document.getElementById('custom-alert-title');
  const bodyEl = document.getElementById('custom-alert-body');
  const iconEl = document.getElementById('custom-alert-icon');
  const okBtn = document.getElementById('custom-alert-ok-btn');
  if (!modal || !bodyEl || !okBtn) {
    alert(message);
    return;
  }

  titleEl.textContent = title;
  bodyEl.textContent = message;

  const iconColorMap = {
    info: 'var(--accent)',
    warn: 'var(--accent-warm)',
    error: 'var(--danger)',
    success: 'var(--success)',
  };
  const iconSvgMap = {
    info: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
    warn: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    error: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    success: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
  };
  iconEl.style.color = iconColorMap[iconType] || iconColorMap.info;
  iconEl.innerHTML = iconSvgMap[iconType] || iconSvgMap.info;

  modal.classList.add('active');

  const close = () => {
    modal.classList.remove('active');
    okBtn.removeEventListener('click', close);
    modal.removeEventListener('click', overlayClose);
    document.removeEventListener('keydown', escClose);
  };
  okBtn.addEventListener('click', close);

  const overlayClose = (e) => {
    if (e.target === modal) close();
  };
  modal.addEventListener('click', overlayClose);

  const escClose = (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) close();
  };
  document.addEventListener('keydown', escClose);
}

export function showBottomToast(message, iconType = 'info', options = {}) {
  const text = String(message || '').trim();
  if (!text) return;

  let host = document.getElementById('app-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'app-toast-host';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'true');
    document.body.appendChild(host);
  }

  const isError = iconType === 'error';
  const isWarn = iconType === 'warn';
  const copyable = Boolean(options.copyable) || isError;
  const defaultDuration = isError ? 8000 : isWarn ? 5000 : 2600;
  const duration = Number(options.duration || defaultDuration);

  const toast = document.createElement('div');
  toast.className = `app-toast app-toast-${iconType || 'info'}${copyable ? ' app-toast-copyable' : ''}`;
  toast.setAttribute('role', 'status');

  const body = document.createElement('span');
  body.className = 'app-toast-body';
  body.textContent = text;
  toast.appendChild(body);

  let hideTimer = null;
  const removeToast = () => {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    toast.classList.remove('show');
    window.setTimeout(() => toast.remove(), 220);
  };

  const actions = document.createElement('span');
  actions.className = 'app-toast-actions';

  if (copyable && typeof navigator?.clipboard?.writeText === 'function') {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'app-toast-action app-toast-copy';
    copyBtn.title = '复制错误信息';
    copyBtn.setAttribute('aria-label', '复制错误信息');
    copyBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>复制</span>';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.classList.add('copied');
        const original = copyBtn.innerHTML;
        copyBtn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span>已复制</span>';
        window.setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = original;
        }, 1600);
      } catch (_) {
        copyBtn.title = '复制失败，请手动复制';
      }
    });
    actions.appendChild(copyBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'app-toast-action app-toast-close';
  closeBtn.title = '关闭';
  closeBtn.setAttribute('aria-label', '关闭提示');
  closeBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  closeBtn.addEventListener('click', removeToast);
  actions.appendChild(closeBtn);

  toast.appendChild(actions);
  host.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));
  hideTimer = window.setTimeout(() => {
    removeToast();
  }, duration);
}

export function showCustomConfirm(message, title, iconType) {
  title = title || '确认';
  iconType = iconType || 'warn';

  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    const titleEl = document.getElementById('custom-confirm-title');
    const leadEl = document.getElementById('modal-lead');
    const questionEl = leadEl?.nextElementSibling;
    const warningEl = modal?.querySelector('.modal-warning');
    const btnCancel = document.getElementById('modal-btn-cancel');
    const btnConfirm = document.getElementById('modal-btn-confirm');

    if (!modal || !btnCancel || !btnConfirm) {
      resolve(confirm(message));
      return;
    }

    const prev = {
      title: titleEl ? titleEl.textContent : '',
      lead: leadEl ? leadEl.textContent : '',
      question: questionEl ? questionEl.textContent : '',
      warningDisplay: warningEl ? warningEl.style.display : '',
      cancelText: btnCancel.textContent,
      confirmText: btnConfirm.textContent,
      confirmWidth: btnConfirm.style.width,
    };

    if (titleEl) titleEl.textContent = title;
    if (leadEl) leadEl.textContent = message;
    if (questionEl) questionEl.textContent = '';
    if (warningEl) warningEl.style.display = 'none';

    const footer = modal.querySelector('.modal-footer');
    if (footer) {
      btnCancel.style.display = '';
      btnCancel.textContent = '取消';
      btnConfirm.style.display = '';
      btnConfirm.textContent = '确定';
      btnConfirm.style.width = '';
    }

    modal.classList.add('active');

    const cleanup = () => {
      modal.classList.remove('active');
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      if (titleEl) titleEl.textContent = prev.title;
      if (leadEl) leadEl.textContent = prev.lead;
      if (questionEl) questionEl.textContent = prev.question;
      if (warningEl) warningEl.style.display = prev.warningDisplay;
      btnCancel.textContent = prev.cancelText;
      btnConfirm.textContent = prev.confirmText;
      btnConfirm.style.width = prev.confirmWidth;
    };

    const onConfirm = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve(true);
    };
    const onCancel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve(false);
    };
    const onOverlay = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(false);
      }
    };
    const onEsc = (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        cleanup();
        resolve(false);
      }
    };

    btnCancel.addEventListener('click', onCancel);
    btnConfirm.addEventListener('click', onConfirm);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEsc);
  });
}

export function showCustomPrompt(message, defaultValue, title) {
  title = title || '输入';
  defaultValue = defaultValue || '';

  return new Promise((resolve) => {
    const modal = document.getElementById('custom-prompt-modal');
    const titleEl = document.getElementById('custom-prompt-title');
    const msgEl = document.getElementById('custom-prompt-message');
    const inputEl = document.getElementById('custom-prompt-input');
    const okBtn = document.getElementById('custom-prompt-ok-btn');
    const cancelBtn = document.getElementById('custom-prompt-cancel-btn');

    if (!modal || !inputEl || !okBtn || !cancelBtn) {
      resolve(window.prompt(message, defaultValue));
      return;
    }

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    inputEl.value = defaultValue;

    modal.classList.add('active');
    setTimeout(() => {
      inputEl.focus();
      inputEl.select();
    }, 50);

    const cleanup = () => {
      modal.classList.remove('active');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      inputEl.removeEventListener('keydown', onEnter);
    };

    const onOk = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve(inputEl.value);
    };
    const onCancel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve(null);
    };
    const onOverlay = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(null);
      }
    };
    const onEsc = (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        cleanup();
        resolve(null);
      }
    };
    const onEnter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        cleanup();
        resolve(inputEl.value);
      }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEsc);
    inputEl.addEventListener('keydown', onEnter);
  });
}

const g = globalThis;
g.showCustomAlert = showCustomAlert;
g.showBottomToast = showBottomToast;
g.showCustomConfirm = showCustomConfirm;
g.showCustomPrompt = showCustomPrompt;
