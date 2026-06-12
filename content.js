// ── state ────────────────────────────────────────────────────────────────────
let lockedItems = [];
let hashedMasterPassword = '';
let isAuthenticatedThisSession = {}; // id → timestamp of authentication
let storageReady = false;
let hiddenMode = false; // toggled by Ctrl+Shift+H

// ── inactivity auto-lock ──────────────────────────────────────────────────────
const INACTIVITY_MS = 3 * 60 * 1000; // 3 minutes
let lastActivityTime = Date.now();

function recordActivity() {
  lastActivityTime = Date.now();
}

// Track any user activity
['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt =>
  document.addEventListener(evt, recordActivity, { passive: true })
);

// Every 15s: expire session auth for IDs where user has been idle ≥3 min.
// If currently ON an expired locked chat, re-gate it.
setInterval(() => {
  const now = Date.now();
  const idle = now - lastActivityTime;
  if (idle < INACTIVITY_MS) return; // still active — nothing to do

  let anyExpired = false;
  Object.keys(isAuthenticatedThisSession).forEach(id => {
    anyExpired = true;
    delete isAuthenticatedThisSession[id];
  });

  if (anyExpired) {
    // If currently on a locked page, show the gate again
    checkCurrentURLProtection();
  }
}, 15_000);

// ── crypto ───────────────────────────────────────────────────────────────────
async function sha256(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── URL → stable ID ──────────────────────────────────────────────────────────
// KEY DESIGN: a chat is identified by its chat UUID alone.
// Whether accessed as /c/<id> or /g/g-p-xxx/c/<id>, the lock key is "c__<chatid>".
// A project root is locked by its gizmo ID "g-p-<id>".
// This prevents the same chat having two different lock IDs depending on entry point.
function getItemId(pathname) {
  if (!pathname) return null;

  // Chat — either /c/<id> or /g/.../c/<id> — canonical key is always c__<chatid>
  const chatMatch = pathname.match(/\/c\/([^/?#]+)/);
  if (chatMatch) return `c__${chatMatch[1]}`;

  // Project root: /g/g-p-<id>
  const projMatch = pathname.match(/\/g\/(g-p-[^/?#/]+)/);
  if (projMatch) return `proj__${projMatch[1]}`;

  // Old-style project: /p/<id>
  const oldProj = pathname.match(/\/p\/([^/?#]+)/);
  if (oldProj) return `p__${oldProj[1]}`;

  return null;
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

  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = 'Password';
  input.style.cssText = `
    width: 100%; box-sizing: border-box; background: #2d2e36;
    border: 1px solid #4a4b5a; border-radius: 6px; color: #ececec;
    padding: 8px 10px; font-size: 13px; outline: none; transition: border-color 0.15s;
  `;
  input.addEventListener('focus', () => input.style.borderColor = '#10a37f');
  input.addEventListener('blur',  () => input.style.borderColor = '#4a4b5a');

  const errorMsg = document.createElement('p');
  errorMsg.style.cssText = 'margin: 6px 0 0; font-size: 12px; color: #f87171; min-height: 16px;';

  const row = document.createElement('div');
  row.style.cssText = 'display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding: 6px 14px; border-radius: 6px; border: 1px solid #4a4b5a;
    background: none; color: #aaa; font-size: 13px; cursor: pointer;
  `;

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Confirm';
  confirmBtn.style.cssText = `
    padding: 6px 14px; border-radius: 6px; border: none;
    background: #10a37f; color: white; font-size: 13px; cursor: pointer;
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

  const fieldStyle = `
    width: 100%; box-sizing: border-box; background: #2d2e36;
    border: 1px solid #4a4b5a; border-radius: 6px; color: #ececec;
    padding: 8px 10px; font-size: 13px; outline: none; margin-bottom: 8px;
    transition: border-color 0.15s;
  `;

  const p1 = document.createElement('input');
  p1.type = 'password'; p1.placeholder = 'New password';
  p1.style.cssText = fieldStyle;

  const p2 = document.createElement('input');
  p2.type = 'password'; p2.placeholder = 'Confirm password';
  p2.style.cssText = fieldStyle;

  [p1, p2].forEach(f => {
    f.addEventListener('focus', () => f.style.borderColor = '#10a37f');
    f.addEventListener('blur',  () => f.style.borderColor = '#4a4b5a');
  });

  const errorMsg = document.createElement('p');
  errorMsg.style.cssText = 'margin: 6px 0 0; font-size: 12px; color: #f87171; min-height: 16px;';

  const row = document.createElement('div');
  row.style.cssText = 'display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding: 6px 14px; border-radius: 6px; border: 1px solid #4a4b5a;
    background: none; color: #aaa; font-size: 13px; cursor: pointer;
  `;

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Set Password';
  confirmBtn.style.cssText = `
    padding: 6px 14px; border-radius: 6px; border: none;
    background: #10a37f; color: white; font-size: 13px; cursor: pointer;
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
let protectionInProgress = false; // guard against re-entrant calls

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

// ── page protection check ─────────────────────────────────────────────────────
function checkCurrentURLProtection() {
  const itemId = getItemId(window.location.pathname);

  if (!itemId || !lockedItems.includes(itemId) || isAuthenticatedThisSession[itemId]) {
    removePageOverlay();
    protectionInProgress = false;
    return;
  }

  // Already showing the modal — don't stack
  if (protectionInProgress) return;
  protectionInProgress = true;

  showPageOverlay();

  showModal({
    title: '🔒 This conversation is locked. Enter master password:',
    onConfirm: async (pass) => {
      const h = await sha256(pass);
      if (h === hashedMasterPassword) {
        isAuthenticatedThisSession[itemId] = true;
        lastActivityTime = Date.now(); // reset idle clock on successful auth
        protectionInProgress = false;
        removePageOverlay();
      } else {
        protectionInProgress = false;
        removePageOverlay();
        window.location.href = 'https://chatgpt.com/';
      }
    },
    onCancel: () => {
      protectionInProgress = false;
      removePageOverlay();
      window.location.href = 'https://chatgpt.com/';
    },
  });
}

// ── hide mode ─────────────────────────────────────────────────────────────────
// Ctrl+Shift+H — toggles visibility of locked chat links in sidebar
function applyHideMode() {
  document.querySelectorAll('nav a[href]').forEach(link => {
    const id = getItemId(link.getAttribute('href') || '');
    if (!id || !lockedItems.includes(id)) return;
    link.style.display = hiddenMode ? 'none' : '';
  });
}

// Toast notification for hide mode toggle
function showToast(msg) {
  const existing = document.getElementById('cl-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'cl-toast';
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #2d2e36; border: 1px solid #4a4b5a; border-radius: 8px;
    color: #ccc; font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12px; padding: 8px 16px; z-index: 2147483645;
    opacity: 0; transition: opacity 0.2s;
    pointer-events: none;
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, 1800);
}

document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+H  (Cmd+Shift+H on Mac)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
    e.preventDefault();
    hiddenMode = !hiddenMode;
    applyHideMode();
    showToast(hiddenMode ? 'Locked chats hidden' : 'Locked chats visible');
  }
});

// ── lock dot helpers ──────────────────────────────────────────────────────────
function makeLockDot() {
  const dot = document.createElement('span');
  dot.className = 'cl-lock-dot';
  dot.style.cssText = `
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; flex-shrink: 0;
    transition: opacity 0.15s; font-size: 10px; line-height: 1;
  `;
  return dot;
}

function updateDot(dot, isLocked, hovered) {
  dot.textContent = isLocked ? '🔒' : '🔓';
  dot.style.opacity = isLocked ? '0.45' : (hovered ? '0.3' : '0');
  dot.title = isLocked ? 'Locked — click to unlock' : 'Click to lock';
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

// ── sidebar link injection ────────────────────────────────────────────────────
function getSidebarLinks() {
  return document.querySelectorAll('nav a[href]');
}

function injectLockButtons() {
  if (!storageReady) return;

  getSidebarLinks().forEach((link) => {
    const href = link.getAttribute('href') || '';
    const itemId = getItemId(href);
    if (!itemId) return;

    // Apply hide-mode visibility
    if (hiddenMode && lockedItems.includes(itemId)) {
      link.style.display = 'none';
      return;
    } else {
      link.style.display = '';
    }

    let dot = link.querySelector('.cl-lock-dot');
    const isLocked = lockedItems.includes(itemId);

    if (!dot) {
      dot = makeLockDot();
      link.style.cssText += '; display: flex !important; align-items: center;';
      link.appendChild(dot);

      // Hover — only hide dot when cursor truly leaves the link (not its children)
      link.addEventListener('mouseenter', () => {
        const locked = lockedItems.includes(getItemId(link.getAttribute('href') || ''));
        updateDot(dot, locked, true);
      });
      link.addEventListener('mouseleave', (e) => {
        if (link.contains(e.relatedTarget)) return;
        const locked = lockedItems.includes(getItemId(link.getAttribute('href') || ''));
        updateDot(dot, locked, false);
      });

      // Link click when locked — ask password, then re-click with auth set
      link.addEventListener('click', async (e) => {
        const id = getItemId(link.getAttribute('href') || '');
        if (!id || !lockedItems.includes(id) || isAuthenticatedThisSession[id]) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        gateAndNavigate(id, () => link.click());
      }, true);

      // Dot click — toggle lock state
      dot.addEventListener('click', async (e) => {
        e.stopImmediatePropagation();
        e.preventDefault();

        const id = getItemId(link.getAttribute('href') || '');
        if (!id) return;

        const ready = await ensurePasswordSet();
        if (!ready) return;

        const currentlyLocked = lockedItems.includes(id);

        if (currentlyLocked) {
          if (isAuthenticatedThisSession[id]) {
            // Already authenticated — unlock without re-prompting
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

// ── shared gate-and-navigate (used by both sidebar + global interceptor) ─────
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

// ── Global link interceptor ───────────────────────────────────────────────────
// Catches ALL anchor clicks — sidebar (belt) + project body links (suspenders).
// The sidebar listener above also fires for nav links; since both set auth first
// and then re-click, the second click passes the guard and only one modal shows.
document.addEventListener('click', async (e) => {
  const anchor = e.target.closest('a[href]');
  if (!anchor) return;

  const href = anchor.getAttribute('href') || '';
  const id = getItemId(href);
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

// URL change detection (SPA polling — lightweight string compare)
let lastPathname = location.pathname;
function checkURLChange() {
  if (location.pathname !== lastPathname) {
    lastPathname = location.pathname;
    checkCurrentURLProtection();
  }
}

// ── init ──────────────────────────────────────────────────────────────────────
loadStorage(() => {
  checkCurrentURLProtection();
  injectLockButtons();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(checkURLChange, 400);
});

// Re-sync when popup changes storage (password change, etc.)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.globalPasswordHash) {
    // Password changed — all session auth is invalid
    isAuthenticatedThisSession = {};
  }
  loadStorage(() => {
    injectLockButtons();
  });
});