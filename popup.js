async function sha256(message) {
  const buf = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = `msg ${type}`;
}

function clearMsg(el) {
  el.textContent = '';
  el.className = 'msg';
}

// Enter key submits on all inputs
function bindEnter(inputs, btn) {
  inputs.forEach(inp => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
    });
  });
}

chrome.storage.local.get(['globalPasswordHash'], async (data) => {
  const hasPassword = !!(data.globalPasswordHash);
  const body = document.body;

  if (hasPassword) {
    body.classList.add('state-has-password');
  } else {
    body.classList.add('state-no-password');
  }

  // ── Set password (first time) ────────────────────────────────────────────
  const setBtn  = document.getElementById('setBtn');
  const setMsg  = document.getElementById('setMsg');
  const newPass1 = document.getElementById('newPass1');
  const newPass2 = document.getElementById('newPass2');

  bindEnter([newPass1, newPass2], setBtn);

  setBtn.addEventListener('click', async () => {
    clearMsg(setMsg);
    const v1 = newPass1.value.trim();
    const v2 = newPass2.value.trim();
    if (!v1) { showMsg(setMsg, 'Password cannot be empty.', 'error'); return; }
    if (v1 !== v2) { showMsg(setMsg, 'Passwords do not match.', 'error'); return; }

    const hash = await sha256(v1);
    chrome.storage.local.set({ globalPasswordHash: hash }, () => {
      showMsg(setMsg, 'Password set!', 'success');
      newPass1.value = '';
      newPass2.value = '';
      // Switch to change-password view
      body.classList.remove('state-no-password');
      body.classList.add('state-has-password');
    });
  });

  // ── Change password ──────────────────────────────────────────────────────
  const changeBtn   = document.getElementById('changeBtn');
  const changeMsg   = document.getElementById('changeMsg');
  const currentPass = document.getElementById('currentPass');
  const changePass1 = document.getElementById('changePass1');
  const changePass2 = document.getElementById('changePass2');

  bindEnter([currentPass, changePass1, changePass2], changeBtn);

  changeBtn.addEventListener('click', async () => {
    clearMsg(changeMsg);

    // Re-fetch latest hash in case it changed since popup opened
    const latest = await new Promise(r => chrome.storage.local.get(['globalPasswordHash'], r));
    const storedHash = latest.globalPasswordHash;

    if (!storedHash) {
      showMsg(changeMsg, 'No password set yet.', 'error'); return;
    }

    const cur  = currentPass.value.trim();
    const v1   = changePass1.value.trim();
    const v2   = changePass2.value.trim();

    if (!cur) { showMsg(changeMsg, 'Enter your current password.', 'error'); return; }
    if (!v1)  { showMsg(changeMsg, 'New password cannot be empty.', 'error'); return; }
    if (v1 !== v2) { showMsg(changeMsg, 'New passwords do not match.', 'error'); return; }

    const curHash = await sha256(cur);
    if (curHash !== storedHash) {
      showMsg(changeMsg, 'Current password is incorrect.', 'error');
      currentPass.value = '';
      currentPass.focus();
      return;
    }

    const newHash = await sha256(v1);
    chrome.storage.local.set({ globalPasswordHash: newHash }, () => {
      showMsg(changeMsg, 'Password updated!', 'success');
      currentPass.value = '';
      changePass1.value = '';
      changePass2.value = '';
    });
  });
});