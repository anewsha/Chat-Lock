// ── site config ──────────────────────────────────────────────────────────────
// Each site needs: how to find sidebar links, how to extract an item ID,
// the home URL to redirect to on cancel, and accent color for UI.
const SITE_CONFIGS = {
  'chatgpt.com': {
    name: 'ChatGPT',
    accentColor: '#10a37f',
    homeUrl: 'https://chatgpt.com/',
    getSidebarLinks: () => document.querySelectorAll('nav a[href]'),
    getItemId(pathname) {
      const chatMatch = pathname.match(/\/c\/([^/?#]+)/);
      if (chatMatch) return `c__${chatMatch[1]}`;
      const projMatch = pathname.match(/\/g\/(g-p-[^/?#/]+)/);
      if (projMatch) return `proj__${projMatch[1]}`;
      const oldProj = pathname.match(/\/p\/([^/?#]+)/);
      if (oldProj) return `p__${oldProj[1]}`;
      return null;
    },
  },
  'gemini.google.com': {
    name: 'Gemini',
    accentColor: '#4285f4',
    homeUrl: 'https://gemini.google.com/',
    getSidebarLinks: () => document.querySelectorAll('a[href*="/app/"]'),
    getItemId(pathname) {
      // Gemini URLs: /app/<id>
      const m = pathname.match(/\/app\/([^/?#]+)/);
      return m ? `gemini__${m[1]}` : null;
    },
  },
  'claude.ai': {
    name: 'Claude',
    accentColor: '#cc6b3c',
    homeUrl: 'https://claude.ai/',
    getSidebarLinks: () => document.querySelectorAll('a[href*="/chat/"], a[href*="/project/"]'),
    getItemId(pathname) {
      // Claude URLs: /chat/<uuid> or /project/<uuid>
      const chatM = pathname.match(/\/chat\/([^/?#]+)/);
      if (chatM) return `claudechat__${chatM[1]}`;
      const projM = pathname.match(/\/project\/([^/?#]+)/);
      if (projM) return `claudeproj__${projM[1]}`;
      return null;
    },
  },
  'www.perplexity.ai': {
    name: 'Perplexity',
    accentColor: '#20b2aa',
    homeUrl: 'https://www.perplexity.ai/',
    getSidebarLinks: () => document.querySelectorAll('a[href*="/search/"], a[href*="/collections/"]'),
    getItemId(pathname) {
      // Perplexity URLs: /search/<slug> or /collections/<id>
      const searchM = pathname.match(/\/search\/([^/?#]+)/);
      if (searchM) return `ppx__${searchM[1]}`;
      const colM = pathname.match(/\/collections\/([^/?#]+)/);
      if (colM) return `ppxcol__${colM[1]}`;
      return null;
    },
  },
};

const hostname = location.hostname;
const SITE = SITE_CONFIGS[hostname] || null;
if (!SITE) throw new Error('[ChatLocker] Unsupported site: ' + hostname);

const ACCENT = SITE.accentColor;

// ── state ────────────────────────────────────────────────────────────────────
let lockedItems = [];
let hashedMasterPassword = '';
let isAuthenticatedThisSession = {}; // id → true when unlocked this session
let storageReady = false;
let hiddenMode = false;

// ── inactivity auto-lock ──────────────────────────────────────────────────────
const INACTIVITY_MS = 3 * 60 * 1000; // 3 minutes
let lastActivityTime = Date.now();

function recordActivity() { lastActivityTime = Date.now(); }
['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt =>
  document.addEventListener(evt, recordActivity, { passive: true })
);

setInterval(() => {
  const idle = Date.now() - lastActivityTime;
  if (idle < INACTIVITY_MS) return;
  let anyExpired = false;
  Object.keys(isAuthenticatedThisSession).forEach(id => {
    anyExpired = true;
    delete isAuthenticatedThisSession[id];
  });
  if (anyExpired) checkCurrentURLProtection();
}, 15_000);

// ── crypto ───────────────────────────────────────────────────────────────────
async function sha256(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── storage ──────────────────────────────────────────────────────────────────
function loadStorage(callback) {
  chrome.storage.local.get(['lockedItems', 'globalPasswordHash'], (data) => {
    lockedItems = data.lockedItems || [];
    hashedMasterPassword = data.globalPasswordHash || '';
    storageReady = true;
    if (callback) callback();
  });
}

function saveLockedItems() {
  chrome.storage.local.set({ lockedItems });
}

// ── shared input style ────────────────────────────────────────────────────────
function styledInput(placeholder) {
  const inp = document.createElement('input');
  inp.type = 'password';
  inp.placeholder = placeholder;
  inp.style.cssText = `
    width: 100%; box-sizing: border-box; background: #2d2e36;
    border: 1px solid #4a4b5a; border-radius: 6px; color: #ececec;
    padding: 8px 10px; font-size: 13px; outline: none; margin-bottom: 8px;
    transition: border-color 0.15s; font-family: ui-sans-serif, system-ui, sans-serif;
  `;
  inp.addEventListener('focus', () => inp.style.borderColor = ACCENT);
  inp.addEventListener('blur',  () => inp.style.borderColor = '#4a4b5a');
  return inp;
}

// ── custom modal ─────────────────────────────────────────────────────────────
let activeModal = null;

function showModal({ title, onConfirm, onCancel }) {
  if (activeModal) activeModal.remove();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: #202123; border: 1px solid #3e3f4b; border-radius: 10px;
    padding: 24px 28px; width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: ui-sans-serif, system-ui, sans-serif; color: #ececec;
  `;

  const h = document.createElement('p');
  h.textContent = title;
  h.style.cssText = 'margin: 0 0 14px; font-size: 14px; font-weight: 500; color: #ececec;';

  const input = styledInput('Password');
  input.style.marginBottom = '0';

  const errorMsg = document.createElement('p');
  errorMsg.style.cssText = 'margin: 6px 0 0; font-size: 12px; color: #f87171; min-height: 16px;';

  const row = document.createElement('div');
  row.style.cssText = 'display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding: 6px 14px; border-radius: 6px; border: 1px solid #4a4b5a;
    background: none; color: #aaa; font-size: 13px; cursor: pointer;
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Confirm';
  confirmBtn.style.cssText = `
    padding: 6px 14px; border-radius: 6px; border: none;
    background: ${ACCENT}; color: white; font-size: 13px; cursor: pointer;
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;

  const doConfirm = () => {
    const val = input.value.trim();
    if (!val) { errorMsg.textContent = 'Password cannot be empty.'; return; }
    closeModal();
    onConfirm(val);
  };
  const doCancel = () => { closeModal(); if (onCancel) onCancel(); };

  confirmBtn.addEventListener('click', doConfirm);
  cancelBtn.addEventListener('click', doCancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doConfirm(); }
    if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) doCancel(); });

  row.append(cancelBtn, confirmBtn);
  box.append(h, input, errorMsg, row);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  activeModal = overlay;
  requestAnimationFrame(() => input.focus());

  function closeModal() {
    overlay.remove();
    if (activeModal === overlay) activeModal = null;
  }
}

// Two-field modal for setting password
function showSetPasswordModal({ title, onConfirm, onCancel }) {
  if (activeModal) activeModal.remove();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: #202123; border: 1px solid #3e3f4b; border-radius: 10px;
    padding: 24px 28px; width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: ui-sans-serif, system-ui, sans-serif; color: #ececec;
  `;

  const h = document.createElement('p');
  h.textContent = title;
  h.style.cssText = 'margin: 0 0 14px; font-size: 14px; font-weight: 500;';

  const p1 = styledInput('New password');
  const p2 = styledInput('Confirm password');
  p2.style.marginBottom = '0';

  const errorMsg = document.createElement('p');
  errorMsg.style.cssText = 'margin: 6px 0 0; font-size: 12px; color: #f87171; min-height: 16px;';

  const row = document.createElement('div');
  row.style.cssText = 'display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding: 6px 14px; border-radius: 6px; border: 1px solid #4a4b5a;
    background: none; color: #aaa; font-size: 13px; cursor: pointer;
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Set Password';
  confirmBtn.style.cssText = `
    padding: 6px 14px; border-radius: 6px; border: none;
    background: ${ACCENT}; color: white; font-size: 13px; cursor: pointer;
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;

  const doConfirm = () => {
    const v1 = p1.value.trim(), v2 = p2.value.trim();
    if (!v1) { errorMsg.textContent = 'Password cannot be empty.'; return; }
    if (v1 !== v2) { errorMsg.textContent = 'Passwords do not match.'; return; }
    closeModal();
    onConfirm(v1);
  };
  const doCancel = () => { closeModal(); if (onCancel) onCancel(); };

  confirmBtn.addEventListener('click', doConfirm);
  cancelBtn.addEventListener('click', doCancel);
  [p1, p2].forEach(f => f.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doConfirm(); }
    if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
  }));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) doCancel(); });

  row.append(cancelBtn, confirmBtn);
  box.append(h, p1, p2, errorMsg, row);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  activeModal = overlay;
  requestAnimationFrame(() => p1.focus());

  function closeModal() {
    overlay.remove();
    if (activeModal === overlay) activeModal = null;
  }
}

// ── page-level protection overlay ────────────────────────────────────────────
let lockOverlay = null;
let protectionInProgress = false;

function showPageOverlay() {
  if (lockOverlay) return;
  lockOverlay = document.createElement('div');
  lockOverlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483646;
    background: #171717; display: flex; align-items: center; justify-content: center;
    color: #555; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 15px;
  `;
  lockOverlay.textContent = '🔒 This conversation is locked';
  document.body.appendChild(lockOverlay);
}

function removePageOverlay() {
  if (lockOverlay) { lockOverlay.remove(); lockOverlay = null; }
}

function checkCurrentURLProtection() {
  const itemId = SITE.getItemId(window.location.pathname);

  if (!itemId || !lockedItems.includes(itemId) || isAuthenticatedThisSession[itemId]) {
    removePageOverlay();
    protectionInProgress = false;
    return;
  }

  if (protectionInProgress) return;
  protectionInProgress = true;
  showPageOverlay();

  showModal({
    title: '🔒 This conversation is locked. Enter master password:',
    onConfirm: async (pass) => {
      const h = await sha256(pass);
      if (h === hashedMasterPassword) {
        isAuthenticatedThisSession[itemId] = true;
        lastActivityTime = Date.now();
        protectionInProgress = false;
        removePageOverlay();
      } else {
        protectionInProgress = false;
        removePageOverlay();
        window.location.href = SITE.homeUrl;
      }
    },
    onCancel: () => {
      protectionInProgress = false;
      removePageOverlay();
      window.location.href = SITE.homeUrl;
    },
  });
}

// ── hide mode ─────────────────────────────────────────────────────────────────
function getHideTarget(link) {
  if (hostname === 'www.perplexity.ai') {
    return link.closest('[class*="sidebar-sub-menu"]') || link.parentElement || link;
  }
  if (hostname === 'claude.ai') {
    return link.closest('li') || link.parentElement || link;
  }
  return link;
}

function applyHideMode() {
  SITE.getSidebarLinks().forEach(link => {
    const id = SITE.getItemId(link.getAttribute('href') || '');
    if (!id || !lockedItems.includes(id)) return;
    const target = getHideTarget(link);
    target.style.display = hiddenMode ? 'none' : '';
  });
  updateFloatingBtn();
}

// ── floating hide/show button ─────────────────────────────────────────────────
let floatingBtn = null;

function createFloatingBtn() {
  if (floatingBtn) return;
  floatingBtn = document.createElement('button');
  floatingBtn.id = 'cl-floating-btn';
  updateFloatingBtnLabel();
  floatingBtn.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483644;
    background: #202123; border: 1px solid #3e3f4b; border-radius: 20px;
    color: #ccc; font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 11px; padding: 6px 12px; cursor: pointer;
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
    transition: background 0.15s, opacity 0.2s, transform 0.15s;
    display: flex; align-items: center; gap: 5px; user-select: none;
    opacity: 0.75;
  `;
  floatingBtn.addEventListener('mouseenter', () => {
    floatingBtn.style.background = '#2d2e36';
    floatingBtn.style.opacity = '1';
    floatingBtn.style.transform = 'scale(1.04)';
  });
  floatingBtn.addEventListener('mouseleave', () => {
    floatingBtn.style.background = '#202123';
    floatingBtn.style.opacity = '0.75';
    floatingBtn.style.transform = 'scale(1)';
  });
  floatingBtn.addEventListener('click', () => {
    hiddenMode = !hiddenMode;
    applyHideMode();
    showToast(hiddenMode ? 'Locked chats hidden' : 'Locked chats visible');
  });
  document.body.appendChild(floatingBtn);
}

function updateFloatingBtnLabel() {
  if (!floatingBtn) return;
  floatingBtn.innerHTML = hiddenMode
    ? '<span style="font-size:13px">👁️‍🗨️</span> Show locked'
    : '<span style="font-size:13px">🔒</span> Hide locked';
}

function updateFloatingBtn() {
  updateFloatingBtnLabel();
}

// ── welcome toast on first visit per site ─────────────────────────────────────
function maybeShowWelcomeToast() {
  const key = `cl_welcomed_${hostname}`;
  chrome.storage.local.get([key], (data) => {
    if (data[key]) return; // already shown
    chrome.storage.local.set({ [key]: true });

    // Delay slightly so page has settled
    setTimeout(() => {
      showWelcomeBanner();
    }, 1500);
  });
}

function showWelcomeBanner() {
  const banner = document.createElement('div');
  banner.style.cssText = `
    position: fixed; bottom: 60px; right: 20px; z-index: 2147483645;
    background: #202123; border: 1px solid ${ACCENT}44;
    border-left: 3px solid ${ACCENT}; border-radius: 8px;
    color: #ccc; font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12px; padding: 12px 14px; width: 230px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    opacity: 0; transition: opacity 0.3s, transform 0.3s;
    transform: translateY(8px);
    line-height: 1.5;
  `;

  banner.innerHTML = `
    <div style="font-weight:600; color:#ececec; margin-bottom:6px; font-size:13px;">
      🔒 AI Chat Locker active
    </div>
    <div style="color:#888; font-size:11px; margin-bottom:10px;">
      Click <b style="color:#ccc">🔒</b> next to any chat in the sidebar to lock it.<br><br>
      Use <kbd style="background:#2d2e36;border:1px solid #3e3f4b;border-radius:3px;padding:1px 5px;font-size:10px;color:#888;">Ctrl+Shift+H</kbd> or the <b style="color:#ccc">button below</b> to hide/show locked chats.
    </div>
    <button id="cl-banner-dismiss" style="
      background: ${ACCENT}; border: none; border-radius: 5px; color: white;
      font-size: 11px; padding: 4px 10px; cursor: pointer; width: 100%;
      font-family: ui-sans-serif, system-ui, sans-serif;
    ">Got it</button>
  `;

  document.body.appendChild(banner);
  requestAnimationFrame(() => {
    banner.style.opacity = '1';
    banner.style.transform = 'translateY(0)';
  });

  const dismiss = () => {
    banner.style.opacity = '0';
    banner.style.transform = 'translateY(8px)';
    setTimeout(() => banner.remove(), 300);
  };

  document.getElementById('cl-banner-dismiss').addEventListener('click', dismiss);

  // Auto-dismiss after 10s
  setTimeout(dismiss, 10000);
}

// ── toast notification ────────────────────────────────────────────────────────
function showToast(msg) {
  const existing = document.getElementById('cl-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'cl-toast';
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed; bottom: 60px; left: 50%; transform: translateX(-50%);
    background: #2d2e36; border: 1px solid #4a4b5a; border-radius: 8px;
    color: #ccc; font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12px; padding: 8px 16px; z-index: 2147483645;
    opacity: 0; transition: opacity 0.2s; pointer-events: none;
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, 1800);
}

// ── keyboard shortcut ─────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
    e.preventDefault();
    hiddenMode = !hiddenMode;
    applyHideMode();
    showToast(hiddenMode ? 'Locked chats hidden' : 'Locked chats visible');
  }
});

// ── lock dot helpers ──────────────────────────────────────────────────────────
// function makeLockDot() {
//   const dot = document.createElement('span');
//   dot.className = 'cl-lock-dot';
//   dot.style.cssText = `
//     display: inline-flex; align-items: center; justify-content: center;
//     width: 16px; height: 16px; flex-shrink: 0;
//     transition: opacity 0.15s; font-size: 10px; line-height: 1;
//   `;
//   return dot;
// }

// ── lock dot helpers ──────────────────────────────────────────────────────────
function makeLockDot() {
  const dot = document.createElement('span');
  dot.className = 'cl-lock-dot';
  dot.style.cssText = `
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; flex-shrink: 0;
    transition: opacity 0.15s, transform 0.1s; font-size: 10px; line-height: 1;
    opacity: 0;
  `;
  // Add a slight scale-up effect when your mouse is directly on the lock/unlock emoji
  dot.addEventListener('mouseenter', () => { dot.style.transform = 'scale(1.2)'; });
  dot.addEventListener('mouseleave', () => { dot.style.transform = 'scale(1)'; });
  return dot;
}
// function updateDot(dot, isLocked, hovered) {
//   dot.textContent = isLocked ? '🔒' : '🔓';
//   dot.style.opacity = isLocked ? '0.45' : (hovered ? '0.3' : '0');
//   dot.title = isLocked ? 'Locked — click to unlock' : 'Click to lock';
// }
function updateDot(dot, isLocked, hovered) {
  dot.textContent = isLocked ? '🔒' : '🔓';
  dot.title = isLocked ? 'Locked — click to unlock' : 'Click to lock';
  
  // If it's locked, it must stay visible at all times
  if (isLocked) {
    dot.style.opacity = '0.55';
  } else {
    // Let the CSS stylesheet handle the hovered vs unhovered opacities dynamically
    if (!hovered) dot.style.opacity = '0.25';
  }
}
async function ensurePasswordSet() {
  if (hashedMasterPassword) return true;
  return new Promise((resolve) => {
    showSetPasswordModal({
      title: 'Set a master password to start locking chats:',
      onConfirm: async (pass) => {
        const hash = await sha256(pass);
        await chrome.storage.local.set({ globalPasswordHash: hash });
        hashedMasterPassword = hash;
        resolve(true);
      },
      onCancel: () => resolve(false),
    });
  });
}

// // ── sidebar link injection ────────────────────────────────────────────────────
// function injectLockButtons() {
//   if (!storageReady) return;

//   SITE.getSidebarLinks().forEach((link) => {
//     const href = link.getAttribute('href') || '';
//     const itemId = SITE.getItemId(href);
//     if (!itemId) return;

//     if (hiddenMode && lockedItems.includes(itemId)) {
//       getHideTarget(link).style.display = 'none';
//       return;
//     } else {
//       getHideTarget(link).style.display = '';
//     }

//     let dot = link.querySelector('.cl-lock-dot');
//     const isLocked = lockedItems.includes(itemId);

//     if (!dot) {
//       dot = makeLockDot();
//       // gap so dot doesn't overlap text; pointer-events:none on link hover area won't block dot
//       link.style.cssText += '; display: flex !important; align-items: center; gap: 4px; overflow: visible !important;';
//       dot.style.pointerEvents = 'auto';
//       link.prepend(dot);

//       let dotHovered = false;
//       dot.addEventListener('mouseenter', () => { dotHovered = true; });
//       dot.addEventListener('mouseleave', () => { dotHovered = false; });

//       link.addEventListener('mouseenter', () => {
//         const locked = lockedItems.includes(SITE.getItemId(link.getAttribute('href') || ''));
//         updateDot(dot, locked, true);
//       });
//       link.addEventListener('mouseleave', (e) => {
//         // Don't hide dot if cursor moved onto the dot itself
//         if (e.relatedTarget === dot || dot.contains(e.relatedTarget)) return;
//         if (link.contains(e.relatedTarget)) return;
//         const locked = lockedItems.includes(SITE.getItemId(link.getAttribute('href') || ''));
//         updateDot(dot, locked, false);
//       });

//       link.addEventListener('click', async (e) => {
//         const id = SITE.getItemId(link.getAttribute('href') || '');
//         if (!id || !lockedItems.includes(id) || isAuthenticatedThisSession[id]) return;
//         e.preventDefault();
//         e.stopImmediatePropagation();
//         gateAndNavigate(id, () => link.click());
//       }, true);

//       dot.addEventListener('click', async (e) => {
//         e.stopImmediatePropagation();
//         e.preventDefault();

//         const id = SITE.getItemId(link.getAttribute('href') || '');
//         if (!id) return;

//         const ready = await ensurePasswordSet();
//         if (!ready) return;

//         const currentlyLocked = lockedItems.includes(id);

//         if (currentlyLocked) {
//           if (isAuthenticatedThisSession[id]) {
//             lockedItems = lockedItems.filter(x => x !== id);
//             delete isAuthenticatedThisSession[id];
//             saveLockedItems();
//             updateDot(dot, false, true);
//           } else {
//             showModal({
//               title: 'Enter master password to unlock permanently:',
//               onConfirm: async (pass) => {
//                 const h = await sha256(pass);
//                 if (h === hashedMasterPassword) {
//                   lockedItems = lockedItems.filter(x => x !== id);
//                   delete isAuthenticatedThisSession[id];
//                   saveLockedItems();
//                   updateDot(dot, false, true);
//                 } else {
//                   showModal({ title: '❌ Incorrect password.', onConfirm: () => {} });
//                 }
//               },
//             });
//           }
//         } else {
//           lockedItems.push(id);
//           saveLockedItems();
//           updateDot(dot, true, true);
//         }
//       });
//     }

//     updateDot(dot, isLocked, false);
//   });
// }

// ── sidebar link injection ────────────────────────────────────────────────────
function injectLockButtons() {
  if (!storageReady) return;

  SITE.getSidebarLinks().forEach((link) => {
    const href = link.getAttribute('href') || '';
    const itemId = SITE.getItemId(href);
    if (!itemId) return;

    if (hiddenMode && lockedItems.includes(itemId)) {
      getHideTarget(link).style.display = 'none';
      return;
    } else {
      getHideTarget(link).style.display = '';
    }

    let dot = link.querySelector('.cl-lock-dot');
    const isLocked = lockedItems.includes(itemId);

    if (!dot) {
      dot = makeLockDot();
      // gap so dot doesn't overlap text; pointer-events:none on link hover area won't block dot
      link.style.cssText += '; display: flex !important; align-items: center; gap: 4px; overflow: visible !important;';
      dot.style.pointerEvents = 'auto';
      link.prepend(dot);

      // // ── START OF FIXED HOVER STATE CHANGES ──
      // // Show symbol when cursor enters the chat name item row
      // link.addEventListener('mouseenter', () => {
      //   const locked = lockedItems.includes(SITE.getItemId(link.getAttribute('href') || ''));
      //   dot.style.opacity = locked ? '0.45' : '0.3';
      // });

      // // Hide symbol when cursor leaves the chat name item row entirely
      // link.addEventListener('mouseleave', () => {
      //   const locked = lockedItems.includes(SITE.getItemId(link.getAttribute('href') || ''));
      //   dot.style.opacity = locked ? '0.45' : '0';
      // });

      // // Highlight to full visibility when cursor sits exactly directly over the button icon hotspot
      // dot.addEventListener('mouseenter', () => {
      //   dot.style.opacity = '1';
      // });

      // // Revert back safely to normal row hover opacity states upon leaving the button hotspot
      // dot.addEventListener('mouseleave', () => {
      //   const locked = lockedItems.includes(SITE.getItemId(link.getAttribute('href') || ''));
      //   dot.style.opacity = locked ? '0.45' : '0.3';
      // });
      // // ── END OF FIXED HOVER STATE CHANGES ──

      link.addEventListener('click', async (e) => {
        const id = SITE.getItemId(link.getAttribute('href') || '');
        if (!id || !lockedItems.includes(id) || isAuthenticatedThisSession[id]) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        gateAndNavigate(id, () => link.click());
      }, true);

      dot.addEventListener('click', async (e) => {
        e.stopImmediatePropagation();
        e.preventDefault();

        const id = SITE.getItemId(link.getAttribute('href') || '');
        if (!id) return;

        const ready = await ensurePasswordSet();
        if (!ready) return;

        const currentlyLocked = lockedItems.includes(id);

        if (currentlyLocked) {
          if (isAuthenticatedThisSession[id]) {
            lockedItems = lockedItems.filter(x => x !== id);
            delete isAuthenticatedThisSession[id];
            saveLockedItems();
            updateDot(dot, false, true);
          } else {
            showModal({
              title: 'Enter master password to unlock permanently:',
              onConfirm: async (pass) => {
                const h = await sha256(pass);
                if (h === hashedMasterPassword) {
                  lockedItems = lockedItems.filter(x => x !== id);
                  delete isAuthenticatedThisSession[id];
                  saveLockedItems();
                  updateDot(dot, false, true);
                } else {
                  showModal({ title: '❌ Incorrect password.', onConfirm: () => {} });
                }
              },
            });
          }
        } else {
          lockedItems.push(id);
          saveLockedItems();
          updateDot(dot, true, true);
        }
      });
    }

    updateDot(dot, isLocked, false);
  });
}

// ── shared gate-and-navigate ──────────────────────────────────────────────────
function gateAndNavigate(id, navigateFn, retryTitle) {
  showModal({
    title: retryTitle || 'Enter master password to open:',
    onConfirm: async (pass) => {
      const h = await sha256(pass);
      if (h === hashedMasterPassword) {
        isAuthenticatedThisSession[id] = true;
        lastActivityTime = Date.now();
        navigateFn();
      } else {
        gateAndNavigate(id, navigateFn, '❌ Incorrect password. Try again:');
      }
    },
  });
}

// ── global link interceptor ───────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  const anchor = e.target.closest('a[href]');
  if (!anchor) return;
  const href = anchor.getAttribute('href') || '';
  const id = SITE.getItemId(href);
  if (!id || !lockedItems.includes(id) || isAuthenticatedThisSession[id]) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  gateAndNavigate(id, () => anchor.click());
}, true);

// ── SPA navigation observer ───────────────────────────────────────────────────
let observerPaused = false;
let injectDebounceTimer = null;

const observer = new MutationObserver(() => {
  if (observerPaused) return;
  clearTimeout(injectDebounceTimer);
  injectDebounceTimer = setTimeout(() => {
    observerPaused = true;
    injectLockButtons();
    applyHideMode();
    observerPaused = false;
  }, 120);
});

let lastPathname = location.pathname;
function checkURLChange() {
  if (location.pathname !== lastPathname) {
    lastPathname = location.pathname;
    checkCurrentURLProtection();
  }
}

// ── init ──────────────────────────────────────────────────────────────────────
// loadStorage(() => {
//   checkCurrentURLProtection();
//   injectLockButtons();
//   createFloatingBtn();
//   maybeShowWelcomeToast();
//   observer.observe(document.body, { childList: true, subtree: true });
//   setInterval(checkURLChange, 400);
// });
// ── init ──────────────────────────────────────────────────────────────────────
loadStorage(() => {
  // 1. Inject mandatory CSS rules to override native platform styles
  const style = document.createElement('style');
  style.textContent = `
    /* Force the row to keep layout context open */
    SITE.getSidebarLinks, a[href] { overflow: visible !important; }
    
    /* When hovering over the sidebar link item row, make the unlock dot visible */
    a[href]:hover .cl-lock-dot { 
      opacity: 0.3 !important; 
    }
    
    /* When the cursor lands directly on the dot itself, light it up completely and scale it */
    .cl-lock-dot:hover { 
      opacity: 1 !important; 
      transform: scale(1.2) !important; 
    }
  `;
  document.head.appendChild(style);

  // 2. Run the rest of your startup sequence safely
  checkCurrentURLProtection();
  injectLockButtons();
  createFloatingBtn();
  maybeShowWelcomeToast();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(checkURLChange, 400);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.globalPasswordHash) {
    isAuthenticatedThisSession = {};
  }
  loadStorage(() => {
    injectLockButtons();
  });
});
