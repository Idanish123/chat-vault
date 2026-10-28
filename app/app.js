/* Local archive UI. Imported content is rendered as text; desktop control requests carry no chat data. */
(() => {
  'use strict';
  const C = window.ChatCore, $ = id => document.getElementById(id);
  const state = { chats: [], active: null, page: 0, perPage: 120, filtered: [], query: '', searchMatches: [], searchIndex: -1, mediaOnly: false, busy: false, generation: 0, urls: new Map(), mediaBytes: 0, galleryLimit: 40, sampleMode: false, importing: false, cancelImport: false };
  let toastTimer, searchTimer, modalCleanup = null, defaultOrder = 'auto';
  let vault = null, library = null, browserStore = null, selectedStore = null, gateExists = false, restoringBackup = null;
  let thumbnailsRunning = 0;
    let logQueue = Promise.resolve(), logFailed = false, lastActivity = Date.now();
  const thumbnailQueue = [];
  const observedThumbnails = new Set();
  function pruneThumbnails(all = false) {
    for (const target of observedThumbnails) if (all || !target.isConnected) { thumbnailObserver.unobserve(target); observedThumbnails.delete(target); delete target._thumbnailJob; }
    for (let i = thumbnailQueue.length - 1; i >= 0; i--) if (all || !thumbnailQueue[i].target.isConnected) thumbnailQueue.splice(i, 1);
  }
  const thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      thumbnailObserver.unobserve(entry.target);
      observedThumbnails.delete(entry.target);
      const job = entry.target._thumbnailJob; delete entry.target._thumbnailJob;
      if (job) thumbnailQueue.push(job);
    }
    drainThumbnails();
  }, { rootMargin: '120px' });
  function drainThumbnails() {
    while (thumbnailsRunning < 2 && thumbnailQueue.length) {
      const task = thumbnailQueue.shift(); if (!task.target.isConnected || task.chat.disposed) continue;
      thumbnailsRunning++;
      mediaURL(task.chat, task.message.attachment).then(url => {
        if (task.target.isConnected && !task.chat.disposed) task.target.replaceChildren(imagePreview(task.chat, task.message, url));
      }).catch(() => { if (task.target.isConnected) task.target.replaceChildren(); }).finally(() => { thumbnailsRunning--; drainThumbnails(); });
    }
  }
  function imagePreview(chat, message, url) {
    const sticker = message.attachment.kind === 'sticker';
    const b = button('', () => showAttachment(chat, message), 'image-preview-button' + (sticker ? ' sticker-preview-button' : '')); b.setAttribute('aria-label', `Open ${sticker ? 'sticker' : 'image'} ${message.attachment.name}`);
    const img = node('img', 'attachment-preview' + (sticker ? ' sticker-preview' : '')); img.alt = message.attachment.caption || (sticker ? 'Sticker: ' : '') + message.attachment.name; img.loading = 'lazy';
    img.addEventListener('load', () => { b.closest('.attachment-wrapper')?.classList.add('preview-loaded'); });
    img.addEventListener('error', () => { b.closest('.attachment-wrapper')?.classList.remove('preview-loaded'); b.remove(); });
    b.append(img); img.src = url; return b;
  }
  function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; if (/message-content|message-sender|chat-row-name|chat-row-preview/.test(cls || '')) n.dir = 'auto'; return n; }
  function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg; }
  function button(text, action, cls = 'text-button') { const b = node('button', cls, text); b.type = 'button'; b.dataset.action = (action.name || 'dialog-action').toLowerCase(); b.addEventListener('click', action); return b; }
  function para(text, cls) { return node('p', cls || '', text); }
  function sizeText(n) { return n === 0 ? '0 B' : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
  function activeChat() { return state.chats.find(c => c.id === state.active); }
  function mediaCacheKey(chat, a) { return chat.id + ':' + (a.sourceFile || 'sample') + ':' + (a.entryName || a.name); }
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000); }
  function logEvent(action, details = {}) {
    const event = window.DMKVault.sanitizeEvent({ at: new Date().toISOString(), action, details }), target = vault;
    const work = async () => {
      try {
        if (target && !target.closed) { await target.appendLog(event); logFailed = false; }
        else if (browserStore) { const events = await browserStore.preference('diagnostics') || []; events.push(event); await browserStore.preference('diagnostics', events.slice(-200)); }
      } catch {
        logFailed = true;
        try { if (browserStore) { const events = await browserStore.preference('diagnostics') || []; events.push({ ...event, action: 'audit.write.failed', details: { operation: action } }); await browserStore.preference('diagnostics', events.slice(-200)); } } catch {}
      }
      updateLibraryHealth();
    };
    logQueue = logQueue.then(work, work); return logQueue;
  }
  function updateLibraryHealth() {
    const target = $('library-health'); if (!target) return;
    if (logFailed) { target.textContent = 'Activity logging needs attention. Check storage access in Backup & security.'; target.classList.add('needs-attention'); return; }
    target.classList.remove('needs-attention');
    if (!vault || vault.closed) { target.textContent = state.sampleMode ? 'Fictional sample · nothing is saved' : ''; return; }
    const recovery = !vault.header.recovery ? 'Recovery key: not set up' : vault.index.settings.recoveryConfirmed === false ? 'Recovery key: save confirmation needed' : 'Recovery key: enabled';
    const saved = vault.index.settings.lastBackupAt, changed = vault.index.settings.credentialsChangedAt;
    target.textContent = recovery + '\n' + (!saved ? 'Backup: not prepared yet' : changed && changed > saved ? 'Backup: prepare a new copy after security changes' : 'Backup prepared: ' + new Date(saved).toLocaleDateString());
  }
  function busy(on, detail) { state.busy = on; $('busy-overlay').hidden = !on; $('app').setAttribute('aria-busy', String(on)); $('cancel-import').hidden = !on || !state.importing; if (detail) $('busy-detail').textContent = detail; }
  async function refreshGate() {
    $('app').hidden = true; $('app').inert = true; $('vault-gate').hidden = false;
    $('vault-heading').textContent = gateExists ? 'Welcome back.' : 'Your chats, here to stay.';
    $('vault-description').textContent = gateExists ? 'Unlock your saved conversations. Your chats and media are still here.' : 'Create an encrypted library. Keep every conversation and its media on your PC.';
    const recoveryRestore = !!restoringBackup && $('restore-with-key').checked;
    $('vault-confirm-wrap').hidden = (gateExists || !!restoringBackup) && !recoveryRestore;
    $('vault-confirm').required = !$('vault-confirm-wrap').hidden;
    $('restore-key-options').hidden = !restoringBackup; $('restore-recovery-key').disabled = !recoveryRestore;
    $('restore-recovery-key').required = recoveryRestore;
    $('vault-submit').disabled = !selectedStore;
    $('vault-submit').textContent = restoringBackup ? 'Restore encrypted backup' : gateExists ? 'Unlock saved library' : 'Create permanent library';
    $('vault-location-label').textContent = selectedStore?.kind === 'folder' ? 'Saved as encrypted files in: ' + selectedStore.handle.name : selectedStore ? 'Saved encrypted in this browser profile. Use the same browser and keep a backup.' : 'Choose a folder for your permanent chat library.';
    $('vault-password').autocomplete = recoveryRestore || !gateExists && !restoringBackup ? 'new-password' : 'current-password';
    document.querySelector('label[for="vault-password"]').textContent = recoveryRestore ? 'New library password (after restore)' : 'Library password';
    $('forgot-password-button').hidden = !gateExists || !!restoringBackup;
  }
  function gateError(e) { $('vault-error').textContent = typeof e === 'string' ? e : e.message; $('vault-error').hidden = false; }
  async function bootVault() {
    try {
      browserStore = await window.DMKVault.BrowserStore.open();
      const pref = await browserStore.preference('location');
      if (pref?.kind === 'folder' && pref.handle) { selectedStore = new window.DMKVault.FolderStore(pref.handle); gateExists = true; }
      else if (await window.DMKVault.Vault.exists(browserStore)) { selectedStore = browserStore; gateExists = true; }
      $('choose-folder').disabled = typeof window.showDirectoryPicker !== 'function';
      await refreshGate();
    } catch (e) { gateError(e); }
  }
  async function chooseFolder() {
    try { const handle = await window.showDirectoryPicker({ id: 'dmk-chat-vault', mode: 'readwrite' }); selectedStore = new window.DMKVault.FolderStore(handle); gateExists = await window.DMKVault.Vault.exists(selectedStore); $('vault-error').hidden = true; await refreshGate(); }
    catch (e) { if (e.name !== 'AbortError') gateError(e); }
  }
  async function chooseBrowser() { try { selectedStore = browserStore || await window.DMKVault.BrowserStore.open(); gateExists = await window.DMKVault.Vault.exists(selectedStore); $('vault-error').hidden = true; await refreshGate(); } catch (e) { gateError(e); } }
  async function unlockLibrary(event) {
    event.preventDefault(); if (state.busy || !selectedStore) return;
    const password = $('vault-password').value, recoveryRestore = !!restoringBackup && $('restore-with-key').checked;
    if ((!gateExists && !restoringBackup || recoveryRestore) && password !== $('vault-confirm').value) { gateError('The passwords do not match.'); return; }
    let showRecovery = false;
    try {
      if (selectedStore.kind === 'folder' && !await selectedStore.permission()) throw Error('Allow access to your vault folder to open the saved chats.');
      busy(true, restoringBackup ? 'Restoring encrypted files on this PC' : gateExists ? 'Unlocking your saved library' : 'Creating encrypted storage on this PC');
      vault = restoringBackup ? await window.DMKVault.Vault.restore(selectedStore, restoringBackup, password, recoveryRestore ? { recoveryKey: $('restore-recovery-key').value } : {}) : gateExists ? await window.DMKVault.Vault.unlock(selectedStore, password) : await window.DMKVault.Vault.create(selectedStore, password);
      logEvent(restoringBackup ? 'vault.restore' : gateExists ? 'vault.unlock' : 'vault.create', { storage: selectedStore.kind });
      library = new window.DMKLibrary.Library(vault);
      if (browserStore) await browserStore.preference('location', selectedStore.kind === 'folder' ? { kind: 'folder', handle: selectedStore.handle } : { kind: 'browser' });
      if (selectedStore.kind === 'browser') navigator.storage?.persist?.().catch(() => {});
      gateExists = true; restoringBackup = null; state.sampleMode = false; $('demo-exit').hidden = true; $('restore-recovery-key').value = ''; $('restore-with-key').checked = false; $('vault-password').value = ''; $('vault-confirm').value = ''; $('vault-error').hidden = true; lastActivity = Date.now();
      $('app').hidden = false; $('app').inert = false; $('vault-gate').hidden = true;
      state.chats = library.list(); document.documentElement.classList.toggle('dark', vault.index.settings.theme === 'dark');
      $('storage-indicator').textContent = selectedStore.kind === 'folder' ? 'Saved encrypted in your PC folder' : 'Saved encrypted in this browser';
      renderSidebar(); $('welcome').hidden = false; $('conversation').hidden = true;
      if (vault.index.settings.active && state.chats.some(c => c.id === vault.index.settings.active)) await openChat(vault.index.settings.active);
      toast(state.chats.length ? 'Your saved conversations are ready.' : 'Library saved on this PC. Import chats to get started.');
      showRecovery = !vault.header.recovery; updateLibraryHealth();
    } catch (e) { gateError(e); logEvent('vault.unlock.failed', { operation: restoringBackup ? 'restore' : 'unlock' }); }
    finally { busy(false); if (showRecovery) securityForm('recovery'); }
  }
  async function lockLibrary(reason = 'manual') {
    if (!vault || state.busy) return;
    busy(true, 'Locking your library');
    try { await logEvent('vault.lock', { reason: typeof reason === 'string' ? reason : 'manual' }); await vault.queue; await vault.lock(); } catch (e) { busy(false); toast(e.message); return; }
    closeModal(); state.generation++; state.chats.forEach(releaseChat); state.chats = []; state.active = null; state.filtered = []; state.urls.clear(); state.mediaBytes = 0; library.cache.clear(); library = null; vault = null;
    $('messages').replaceChildren(); $('gallery-items').replaceChildren(); $('media-panel').hidden = true; pruneThumbnails(true); $('chat-search').value = ''; renderSidebar(); await refreshGate();
    $('conversation-name').textContent = ''; $('conversation-meta').textContent = ''; updateLibraryHealth(); busy(false); $('vault-password').focus();
  }
  async function backupLibrary() {
    if (!vault) return;
    try { busy(true, 'Validating every library record before preparing a backup'); await yieldUI(); const file = await vault.backup(), url = URL.createObjectURL(file), a = node('a'); a.href = url; a.download = 'DMK-Chat-Vault-' + new Date().toISOString().slice(0, 10) + '.dmkvault'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); await vault.change(index => { index.settings.lastBackupAt = new Date().toISOString(); }); logEvent('backup.download', { bytes: file.size }); updateLibraryHealth(); toast('Validated backup prepared. Check that your browser saved the download.'); }
    catch (e) { toast(e.message); } finally { busy(false); }
  }
  async function downloadActivityLog() {
    try {
      await logQueue;
      let activity = [];
      try { if (vault) activity = await vault.readLog(); } catch { logFailed = true; updateLibraryHealth(); }
      const events = [...activity, ...(browserStore ? await browserStore.preference('diagnostics') || [] : [])].sort((a, b) => a.at.localeCompare(b.at));
      const content = events.map(item => JSON.stringify(item)).join('\r\n') + (events.length ? '\r\n' : '');
      const url = URL.createObjectURL(new Blob([content], { type: 'application/x-ndjson;charset=utf-8' })), a = node('a'); a.href = url; a.download = 'DMK-Chat-Vault-activity-' + new Date().toISOString().slice(0, 10) + '.jsonl'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      logEvent('activity-log.export', { events: events.length }); toast('Activity log downloaded. It contains actions and counts, not message contents or passwords.');
    } catch (e) { toast('Could not read the activity log: ' + e.message); }
  }
  function storageSettings() {
    if (!vault) { exitSample(); return; }
    const actions = node('div', 'modal-actions'); actions.append(button('Download encrypted backup', backupLibrary, 'primary-button'), button('Change password', () => securityForm('password')), button(vault.header.recovery ? 'Replace recovery key' : 'Set up password recovery', () => securityForm('recovery')), button('Download activity log', downloadActivityLog), button('Lock library', lockLibrary));
    const pc = node('a', 'text-button', 'Download offline single-file viewer'); pc.href = 'offline.html'; pc.download = 'DMK-Chat-Vault-Offline.html'; if (location.protocol !== 'file:') actions.append(pc);
    const children = [heading('Permanent library'), para(`${vault.index.chats.length} saved conversations. Chat history, stickers, media, names and your message alignment remain after closing the app.`), para(selectedStore.kind === 'folder' ? 'Encrypted library files live in your chosen PC folder: ' + selectedStore.handle.name + '. Keep that folder when updating the viewer.' : 'Your encrypted library lives in this browser profile. Clearing site data, a private/incognito window, or removing the browser profile can remove it. A PC folder and encrypted backups give you a separate copy.'), heading('New exports update existing chats'), para('A matching full export replaces overlapping history. Partial or shorter exports retain older messages and add only new occurrences. Missing media can be retained from the earlier export. You can undo the latest import for each conversation.'), actions];
    children.push(para('Application: ' + (window.DMKDesktop?.version || 'bundled offline/source edition') + '. Use the updated application to read newly saved conversation records.'));
    const idleLabel = node('label', '', 'Automatically lock after inactivity'), idle = node('select'); idle.setAttribute('aria-label', 'Automatic lock timeout');
    for (const value of [5, 10, 15, 30]) { const option = node('option', '', value + ' minutes'); option.value = String(value); idle.append(option); }
    idle.value = String(vault.index.settings.idleMinutes || 10); idle.addEventListener('change', async () => { try { await vault.change(index => { index.settings.idleMinutes = Number(idle.value); }); logEvent('security.idle-timeout.change', { minutes: Number(idle.value) }); } catch (e) { toast(e.message); } }); idleLabel.append(idle); children.push(idleLabel, para('Recovery: ' + (vault.header.recovery ? vault.index.settings.recoveryConfirmed === false ? 'key generated; save confirmation needed' : 'enabled' : 'not set up') + '. ' + (vault.index.settings.lastBackupAt ? 'Last backup prepared: ' + new Date(vault.index.settings.lastBackupAt).toLocaleString() : 'No backup has been prepared yet.') + '. Background processing: ' + (window.DMKProcessor?.mode || 'compatibility') + '.'));
    const chat = activeChat(); const meta = chat && vault.index.chats.find(c => c.id === chat.id);
    if (meta?.previous) children.push(button('Undo latest import for ' + meta.name, async () => { try { busy(true, 'Restoring the previous saved import'); await library.undo(meta.id); closeModal(); state.chats.forEach(releaseChat); state.chats = library.list(); state.active = null; await openChat(meta.id); toast('Previous import restored.'); } catch (e) { toast(e.message); } finally { busy(false); } }));
    openModal('Your PC library', children);
  }
  function credentialField(form, id, label, autocomplete, minLength = 12) {
    const wrapper = node('label', 'credential-field', label), input = node('input');
    input.id = id; input.name = id; input.type = 'password'; input.autocomplete = autocomplete; input.required = true; input.minLength = minLength;
    wrapper.htmlFor = id; wrapper.append(input); form.append(wrapper); return input;
  }
  function formError(form) {
    const error = para('', 'vault-error'); error.setAttribute('role', 'alert'); error.hidden = true; form.append(error); return error;
  }
  function showRecoveryKey(secret) {
    const key = node('code', 'recovery-key', secret), label = node('label', 'recovery-confirm'), saved = node('input');
    saved.type = 'checkbox'; label.append(saved, document.createTextNode('I saved my recovery key somewhere safe.'));
    const done = button('I saved it — continue', async () => { try { await vault.change(index => { index.settings.recoveryConfirmed = true; }); logEvent('vault.recovery-key.confirm'); updateLibraryHealth(); closeModal(); } catch (e) { toast(e.message); } }, 'primary-button'); done.disabled = true;
    saved.addEventListener('change', () => { done.disabled = !saved.checked; });
    const download = button('Download recovery key', () => {
      const text = 'DMK Chat Vault recovery key\r\n\r\n' + secret + '\r\n\r\nKeep this key separate from your vault and backups. Anyone with this key and your vault can reset the password and read your chats.\r\n';
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), link = node('a'); link.href = url; link.download = 'DMK-Chat-Vault-Recovery-Key.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      logEvent('recovery-key.download');
    });
    const actions = node('div', 'modal-actions'); actions.append(download, done);
    openModal('Save your recovery key', [para('This key is shown once. Save it in a password manager or print it and keep it separate from your vault. Anyone with this key and your vault can reset the password and read your chats.'), key, para('If you close this window without saving it, you can generate a replacement while you still know your password.'), label, actions]);
  }
  function securityForm(mode) {
    if (!vault || state.busy) return;
    const recovery = mode === 'recovery', targetVault = vault, form = node('form', 'credentials-form');
    const current = credentialField(form, 'security-current-password', 'Current library password', 'current-password', 1);
    const next = recovery ? null : credentialField(form, 'security-new-password', 'New password (at least 12 characters)', 'new-password');
    const confirm = recovery ? null : credentialField(form, 'security-confirm-password', 'Confirm new password', 'new-password');
    const error = formError(form), submit = node('button', 'primary-button', recovery ? 'Generate recovery key' : 'Change password'); submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (state.busy || vault !== targetVault) return;
      if (next && next.value !== confirm.value) { error.textContent = 'The new passwords do not match.'; error.hidden = false; return; }
      error.hidden = true; submit.disabled = true;
      try {
        busy(true, recovery ? 'Setting up password recovery' : 'Changing your library password');
        if (recovery) { const secret = await targetVault.setupRecovery(current.value); logEvent('vault.recovery-key.replace'); current.value = ''; if (form.isConnected) showRecoveryKey(secret); }
        else { await targetVault.changePassword(current.value, next.value); logEvent('vault.password.change'); current.value = ''; next.value = ''; confirm.value = ''; closeModal(); toast('Password changed. Download a fresh encrypted backup. Older backups still use their previous password.'); }
      } catch (e) { current.value = ''; error.textContent = e.message; error.hidden = false; logEvent('vault.credentials.failed', { operation: recovery ? 'recovery-setup' : 'password-change' }); }
      finally { busy(false); submit.disabled = false; }
    });
    openModal(recovery ? 'Set up password recovery' : 'Change library password', [para(recovery ? 'Save a recovery key to reset your password if you forget it. Generating a replacement invalidates the previous key for this library. Older backups keep the key they had when created.' : 'Confirm your current password and choose a new one. Your saved chats and media will remain available. Your existing recovery key stays valid.'), form]);
  }
  async function forgotPassword() {
    if (state.busy || !selectedStore || !gateExists || restoringBackup) return;
    const store = selectedStore;
    try {
      if (store.kind === 'folder' && !await store.permission()) throw Error('Allow access to the vault folder to reset its password.');
      if (!await window.DMKVault.Vault.hasRecovery(store)) {
        openModal('Password recovery is not set up', [para('This library has no recovery key. You must use its current password to unlock it, then set up recovery in Backup & storage. Without the password or a recovery key created earlier, encrypted chats cannot be recovered.'), button('Close', closeModal, 'primary-button')]); return;
      }
      const form = node('form', 'credentials-form');
      const key = credentialField(form, 'reset-recovery-key', 'Saved recovery key', 'off', 1); key.spellcheck = false;
      const next = credentialField(form, 'reset-new-password', 'New password (at least 12 characters)', 'new-password');
      const confirm = credentialField(form, 'reset-confirm-password', 'Confirm new password', 'new-password');
      const error = formError(form), submit = node('button', 'primary-button', 'Reset password'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (state.busy) return;
        if (next.value !== confirm.value) { error.textContent = 'The new passwords do not match.'; error.hidden = false; return; }
        error.hidden = true; submit.disabled = true;
        try {
          busy(true, 'Resetting your library password');
          const result = await window.DMKVault.Vault.resetPassword(store, key.value, next.value); logFailed = !result.auditSaved;
          key.value = ''; next.value = ''; confirm.value = ''; $('vault-password').value = ''; closeModal(); await refreshGate();
          toast('Password reset. Unlock with your new password and download a fresh backup.'); $('vault-password').focus();
        } catch (e) { key.value = ''; error.textContent = e.message; error.hidden = false; logEvent('vault.reset.failed', { operation: 'recovery-reset' }); }
        finally { busy(false); submit.disabled = false; }
      });
      openModal('Reset forgotten password', [para('Enter the recovery key you saved for this library and choose a new password. Your chats and media will be preserved. Older backups keep their previous passwords.'), form]);
    } catch (e) { gateError(e); }
  }
  function chooseImportTarget(item) {
    return new Promise(resolve => {
      let settled = false;
      const cancel = () => { if (!$('modal').open) finish(undefined); };
      const finish = value => { if (settled) return; settled = true; $('modal').removeEventListener('close', cancel); resolve(value); };
      const select = node('select'); select.setAttribute('aria-label', 'Conversation to update');
      const fresh = node('option', '', 'Save as a separate new conversation'); fresh.value = ''; select.append(fresh);
      for (const c of item.possible) { const o = node('option', '', `${c.name} · ${c.count.toLocaleString()} saved messages`); o.value = c.id; select.append(o); }
      if (item.possible.length === 1) select.value = item.possible[0].id;
      const done = button('Continue import', () => { const id = select.value || null; finish(id); closeModal(); }, 'primary-button');
      openModal('Choose the conversation to update', [para('This export may belong to a saved conversation, but its name or participants changed. Choose the correct chat so unrelated histories stay separate.'), select, done]);
      $('modal').addEventListener('close', cancel);
    });
  }
  function chooseDateOrder(item) {
    return new Promise(resolve => {
      let settled = false;
      const cancel = () => { if (!$('modal').open) finish(undefined); };
      const finish = value => { if (settled) return; settled = true; $('modal').removeEventListener('close', cancel); resolve(value); };
      const select = node('select'); select.setAttribute('aria-label', 'Numeric date order');
      for (const [value, text] of [['DMY', 'Day / Month / Year — 03/04 means 3 April'], ['MDY', 'Month / Day / Year — 03/04 means March 4']]) { const o = node('option', '', text); o.value = value; select.append(o); }
      openModal('Confirm the dates before saving', [para('All dates in this export could be read in either order. Choose the format used by the exporting phone.'), select, button('Save with this date format', () => { const order = select.value; finish(order); closeModal(); }, 'primary-button')]);
      $('modal').addEventListener('close', cancel);
    });
  }
  async function deleteSavedChat() {
    const chat = activeChat(); if (!chat) return;
    if (chat.sample) { releaseChat(chat); state.chats = state.chats.filter(c => c.id !== chat.id); state.active = null; $('conversation').hidden = true; $('welcome').hidden = false; renderSidebar(); logEvent('chat.sample.remove'); return; }
    const actions = node('div', 'modal-actions'); actions.append(button('Cancel', closeModal), button('Delete saved conversation', async () => {
      try { busy(true, 'Deleting this conversation from the saved library'); await library.remove(chat.id); logEvent('chat.delete', { messages: chat.count ?? chat.messages.length }); releaseChat(chat); state.chats = library.list(); state.active = null; closeModal(); $('messages').replaceChildren(); $('gallery-items').replaceChildren(); $('media-panel').hidden = true; renderSidebar(); if (state.chats.length) await openChat(state.chats[0].id); else { $('conversation').hidden = true; $('welcome').hidden = false; } toast('Saved conversation deleted. Original export files are unchanged.'); }
      catch (e) { toast(e.message); } finally { busy(false); }
    }, 'primary-button danger-button'));
    openModal('Delete ' + chat.name + '?', [para('Delete this conversation and its previous import from the permanent library. Other chats and your original ZIP/RAR files remain. Existing downloaded backups may still contain it.'), actions]);
  }

  const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
  function cleanModal() { if (modalCleanup) { modalCleanup(); modalCleanup = null; } $('modal-body').replaceChildren(); }
  function closeModal() { $('modal').close(); cleanModal(); }
  function openModal(title, children) {
    if ($('modal').open) closeModal();
    $('modal-title').textContent = title; $('modal-body').replaceChildren(...children); $('modal').showModal();
  }
  $('modal').addEventListener('close', () => { if (!$('modal').open) cleanModal(); });
  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) { const r = $('modal').getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeModal(); } });
  function heading(t) { return node('h3', '', t); }
  function privacyDetails() {
    const offline = node('a', 'primary-button', 'Download offline viewer'); offline.href = pcDownloadURL; offline.download = 'DMK-Chat-Vault-PC.zip'; offline.textContent = 'Download Windows PC edition';
    const source = node('a', 'text-button', 'Download source code'); source.href = 'dmk-chat-vault-source.zip'; source.download = 'dmk-chat-vault-source.zip';
    const actions = node('div', 'modal-actions'); actions.append(offline, source);

    openModal('Your chats stay with you', [heading('Permanent, encrypted, local'), para('Chats and media are saved with AES-256-GCM encryption, using a data key protected by your password with PBKDF2-SHA-256. Choose a PC folder to keep independent encrypted vault files, or use saved storage in this browser profile. Closing the app locks the library; it does not delete saved conversations.'), heading('New exports continue the same history'), para('A full overlapping export updates its matching conversation instead of making a duplicate. Partial or shorter exports keep existing history. Repeated identical messages are matched by occurrence, and original media can be retained when a newer export omits it. Ambiguous conversation identities ask you to choose. The previous import can be restored in Backup & storage.'), heading('No cloud chat storage'), para('The viewer does not upload chats or media or use analytics. ZIP and RAR extraction, search, encryption, media previews and backups run on this PC. The PC edition uses a local app window; the hosted version still sends normal page requests and account access metadata to its hosting provider.'), heading('Keep a backup and your password'), para('Download an encrypted backup in Backup & storage. A PC folder survives clearing browser site data; browser-only storage can be removed when site data or the browser profile is cleared. Clearing or losing the vault folder also removes that local copy. Set up a recovery key in Backup & storage to reset a forgotten password. Without a previously saved recovery key, the current password is required. There is no cloud recovery. Your original WhatsApp exports and any plain text downloads remain unencrypted.'), heading('Import and display limits'), para('ZIP up to 250 MB; RAR up to 100 MB; TXT up to 20 MB; attachments up to 100 MB. Up to 200 saved conversations and 200,000 messages per conversation; one saved conversation is decrypted for viewing at a time. Encrypted, split and unsupported archive variants are rejected. Missing sticker/media files cannot be recreated. Emoji artwork depends on device fonts.'), para('No app can guarantee 100% security. A compromised device or extension can read an unlocked library. This independent archive viewer cannot send messages, restore exports into WhatsApp, recover deleted content or invent delivery/read receipts.', 'modal-note'), actions]);
  }
  function exportGuide() {
    const android = node('ol'), iphone = node('ol');
    ['Open a conversation in WhatsApp.', 'Tap ⋮ → More → Export chat.', 'Choose Include media if you want photos, videos, audio, and documents.', 'Save the exported ZIP to your device, then choose Import a chat here.'].forEach(t => android.append(node('li', '', t)));
    ['Open a conversation and tap the contact or group name.', 'Choose Export Chat, then Attach Media if required.', 'Save the export to Files and select the saved ZIP here.'].forEach(t => iphone.append(node('li', '', t)));
    const label = node('label', '', 'Default numeric date order'), select = node('select'); select.setAttribute('aria-label', 'Default date order for imports');
    [['auto', 'Auto-detect (day/month when ambiguous)'], ['DMY', 'Day / Month / Year'], ['MDY', 'Month / Day / Year']].forEach(([v, t]) => { const o = node('option', '', t); o.value = v; select.append(o); }); select.value = defaultOrder; select.addEventListener('change', () => { defaultOrder = select.value; }); label.append(select);
    openModal('Bring your conversations home', [heading('Android'), android, heading('iPhone'), iphone, para('A WhatsApp export is different from an encrypted backup (.crypt) or a full account data report. Export each conversation you want to view. If your device gives you separate files, ZIP the transcript together with its media before importing.', 'modal-note'), heading('Import settings'), label, para('For example, 03/04 can mean 3 April or March 4. Set the date order before importing an ambiguous transcript.')]);
  }
  function releaseChat(chat) {
    chat.disposed = true;
    for (const [key, value] of state.urls) if (key.startsWith(chat.id + ':')) { URL.revokeObjectURL(value.url); state.mediaBytes -= value.size; state.urls.delete(key); }
    chat.zip = null; chat.raw = ''; chat.messages = []; chat.files = null; chat.demoFiles = null; chat.sourceFile = null;
  }
  function initials(name) { return name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase() || 'C'; }
  function dateLabel(day) { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function renderSidebar() {
    $('chat-count').textContent = state.chats.length; $('clear-button').disabled = !vault;
    $('library-label').textContent = state.chats.length && state.chats.every(c => c.sample) ? 'SAMPLE CHATS' : 'YOUR LIBRARY';
    $('library-size').textContent = state.chats.length ? `${state.chats.reduce((n, c) => n + (c.count ?? c.messages.length), 0).toLocaleString()} MESSAGES` : 'SAVED ON THIS PC';
    const list = $('chat-list'); list.replaceChildren();
    const q = C.normalize($('chat-search').value.trim());
    const chats = state.chats.filter(c => (!state.mediaOnly || (c.mediaCount ?? c.messages.filter(m => m.attachment).length) > 0) && (!q || C.normalize(c.name + ' ' + (c.participants || []).join(' ') + ' ' + (c.preview || '')).includes(q)));
    if (!chats.length) { const div = node('div', 'empty-library'); const circle = node('div', 'empty-library-icon'); circle.append(icon('chat')); div.append(circle, node('h2', '', state.chats.length ? 'No matching conversations' : 'A home for your conversations'), para(state.chats.length ? 'Try a different search or filter.' : 'Import an exported chat.\nIt will appear right here.')); list.append(div); return; }
    for (const chat of chats) {
      const row = button('', () => openChat(chat.id), 'chat-row' + (chat.id === state.active ? ' active' : '')); row.setAttribute('aria-pressed', String(chat.id === state.active));
      const av = node('div', `chat-avatar color-${chat.color}`, initials(chat.name)), body = node('div', 'chat-row-body'), top = node('div', 'chat-row-top'), bottom = node('div', 'chat-row-bottom');
      const last = chat.messages[chat.messages.length - 1] || (chat.lastDay ? { day: chat.lastDay, text: chat.preview } : null);
      top.append(node('span', 'chat-row-name', chat.name), node('span', 'chat-row-date', last ? dateLabel(last.day).replace(/,? \d{4}$/, '') : ''));
      bottom.append(node('span', 'chat-row-preview', last ? (last.sender ? last.sender + ': ' : '') + (last.attachment ? last.attachment.name : last.text) : 'No messages'), node('span', 'chat-row-count', (chat.count ?? chat.messages.length).toLocaleString()));
      body.append(top, bottom); row.append(av, body); list.append(row);
    }
  }
  function resetFilters(render = true) { $('sender-filter').value = ''; $('date-from').value = ''; $('date-to').value = ''; $('type-filter').value = ''; $('message-search').value = ''; state.query = ''; if (render) applyFilters(); }
  function fillParticipants(chat) {
    $('view-as').replaceChildren(); $('sender-filter').replaceChildren();
    const all = node('option', '', 'Everyone'); all.value = ''; $('sender-filter').append(all);
    if (!chat.participants.length) { const o = node('option', '', 'System messages'); o.value = ''; $('view-as').append(o); }
    for (const p of chat.participants) { const a = node('option', '', p), b = node('option', '', p); a.value = p; b.value = p; $('view-as').append(a); $('sender-filter').append(b); }
    $('view-as').value = chat.viewAs;
  }
  async function openChat(id) {
    let chat = state.chats.find(c => c.id === id); if (!chat) return;
    if (!chat.sample && !chat.loaded) {
      try {
        busy(true, 'Opening your saved conversation');
        const loaded = await library.open(id);
        for (let i = 0; i < state.chats.length; i++) if (state.chats[i].id !== id && state.chats[i].loaded && !state.chats[i].sample) { const previous = state.chats[i]; releaseChat(previous); state.chats[i] = library.list().find(c => c.id === previous.id); }
        chat = loaded; state.chats[state.chats.findIndex(c => c.id === id)] = chat;
      } catch (e) { toast(e.message); return; } finally { busy(false); }
    }
    if (!chat.sample) { vault.change(index => { index.settings.active = id; }).catch(e => toast(e.message)); logEvent('chat.open', { messages: chat.count ?? chat.messages.length }); }
    state.active = id; state.galleryLimit = 40; $('gallery-items').replaceChildren(); $('media-panel').hidden = true; $('filters').hidden = true; $('message-search-bar').hidden = true;
    resetFilters(false); fillParticipants(chat); $('welcome').hidden = true; $('conversation').hidden = false; $('app').classList.remove('mobile-library');
    $('conversation-name').textContent = chat.name; $('conversation-meta').textContent = `${chat.participants.length} participant${chat.participants.length === 1 ? '' : 's'} · ${chat.sample ? 'Fictional sample conversation' : 'Local WhatsApp export'}`;
    $('conversation-avatar').className = 'chat-avatar color-' + chat.color; $('conversation-avatar').textContent = initials(chat.name); $('sample-badge').hidden = !chat.sample;
    renderNotice(chat); renderSidebar(); applyFilters(true);
  }
  function renderNotice(chat) {
    const notices = [];
    if (chat.ambiguous) notices.push('Dates are ambiguous; day/month is selected.');
    if (chat.invalidDates) notices.push(`${chat.invalidDates} message(s) with invalid dates skipped.`);
    if (chat.leadingLines) notices.push(`${chat.leadingLines} line(s) before the first message ignored.`);
    $('import-notice').replaceChildren(); $('import-notice').hidden = !notices.length;
    if (notices.length) $('import-notice').append(node('span', '', notices.join(' ')), button('Import settings', chatDetails));
  }
  function applyFilters(latest = false) {
    const chat = activeChat(); if (!chat) return;
    const q = C.normalize($('message-search').value.trim()), sender = $('sender-filter').value, from = $('date-from').value, to = $('date-to').value, type = $('type-filter').value;
    state.query = q;
    if (from && to && from > to) { state.filtered = []; toast('The From date must be on or before the To date.'); }
    else state.filtered = chat.messages.filter(m => (!sender || m.sender === sender) && (!from || m.day >= from) && (!to || m.day <= to) && (!type || (type === 'media' ? m.attachment : type === 'links' ? /https?:\/\/\S+/i.test(m.text) : m.attachment?.kind === type)));
    state.searchMatches = q ? state.filtered.map((m, i) => m.search.includes(q) ? i : -1).filter(i => i >= 0) : [];
    state.searchIndex = state.searchMatches.length - 1;
    state.page = q && state.searchIndex >= 0 ? Math.floor(state.searchMatches[state.searchIndex] / state.perPage) : latest ? Math.max(0, Math.ceil(state.filtered.length / state.perPage) - 1) : 0;
    $('message-count').textContent = (q ? state.searchMatches.length.toLocaleString() + ' matches · ' : '') + `${state.filtered.length.toLocaleString()} of ${(chat.count ?? chat.messages.length).toLocaleString()} messages`;
    renderMessages(latest);
    $('filter-button').classList.toggle('selected', Boolean(sender || from || to || type));
    updateSearchNavigation();
    if (q) focusSearchMatch();
    logEvent('messages.filter', { queryPresent: Boolean(q), matches: state.filtered.length, senderFilter: Boolean(sender), dateFilter: Boolean(from || to), typeFilter: Boolean(type) });
  }
  function updateSearchNavigation() {
    const count = state.searchMatches.length;
    $('search-result-count').textContent = count ? `${state.searchIndex + 1} of ${count}` : state.query ? '0 matches' : '';
    $('search-previous').disabled = count < 2; $('search-next').disabled = count < 2;
  }
  function jumpToSearchMatch(direction) {
    const count = state.searchMatches.length; if (!count) return;
    state.searchIndex = (state.searchIndex + direction + count) % count;
    const index = state.searchMatches[state.searchIndex]; state.page = Math.floor(index / state.perPage); renderMessages();
    focusSearchMatch();
    updateSearchNavigation(); logEvent('messages.search.navigate', { direction: direction < 0 ? 'previous' : 'next', result: state.searchIndex + 1, total: count });
  }
  function focusSearchMatch() {
    requestAnimationFrame(() => {
      const index = state.searchMatches[state.searchIndex], target = $('messages').querySelector(`[data-message-index="${index}"]`);
      target?.classList.add('search-active'); target?.setAttribute('aria-current', 'true');
      target?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  }
  function highlighted(container, text) {
    // Never turn a message, a filename, or a participant into executable markup.
    if (!state.query || state.query.length > 150) { container.textContent = text; return; }
    let start = 0;
    for (const [from, to] of C.matchRanges(text, state.query)) { container.append(document.createTextNode(text.slice(start, from)), node('mark', '', text.slice(from, to))); start = to; }
    container.append(document.createTextNode(text.slice(start)));
  }
  function attachmentCard(chat, m, gallery = false) {
    const a = m.attachment, sticker = a.kind === 'sticker', visual = sticker || a.kind === 'image', wrap = node('div', 'attachment-wrapper' + (sticker ? ' sticker-attachment' : ''));
    const card = node('div', 'attachment-card'), info = node('div', 'attachment-info');
    info.append(node('div', 'attachment-name', a.name), node('div', 'attachment-subtitle', a.entry || chat.demoFiles?.has(a.name) ? `${a.kind} · ${a.entry ? sizeText(a.entry.size) : 'sample media'}` : a.ambiguous ? 'Duplicate filename — preview disabled' : 'Not included in this export'));
    card.append(icon(a.kind === 'missing' ? 'file' : a.kind === 'document' ? 'file' : a.kind), info);
    const cached = state.urls.get(mediaCacheKey(chat, a));
    const autoPreview = visual && !(sticker && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (autoPreview && cached) wrap.append(imagePreview(chat, m, cached.url));
    else if (autoPreview && a.entry && a.entry.size <= 8 * 1024 ** 2) {
      const slot = node('div', 'thumbnail-slot'); slot._thumbnailJob = { target: slot, chat, message: m }; wrap.append(slot); observedThumbnails.add(slot); thumbnailObserver.observe(slot);
    }
    if (a.entry || chat.demoFiles?.has(a.name)) { const b = button('', () => showAttachment(chat, m), 'icon-button'); b.title = 'Open attachment'; b.setAttribute('aria-label', 'Open ' + a.name); b.append(icon('download')); card.append(b); }
    wrap.append(card); return wrap;
  }
  function renderMessages(scrollBottom = false) {
    const chat = activeChat(); if (!chat) return;
    const target = $('messages'); target.replaceChildren();
    pruneThumbnails();
    const count = state.filtered.length, pages = Math.max(1, Math.ceil(count / state.perPage)); state.page = Math.max(0, Math.min(state.page, pages - 1));
    const start = state.page * state.perPage, batch = state.filtered.slice(start, start + state.perPage);
    const banner = node('div', 'archive-banner', chat.sample ? 'You’re exploring fictional sample chats. Import your export to make this space your own.' : 'Your exported conversation is processed on this device. Only files you select are read; no chat data is uploaded.'); target.append(banner);
    if (!batch.length) { const no = node('div', 'no-results'); no.append(node('h2', '', 'No messages found'), para('Try another search or reset your filters.'), button('Reset search & filters', () => resetFilters())); target.append(no); }
    let previousDay = '';
    for (const [offset, m] of batch.entries()) {
      if (m.day !== previousDay) { target.append(node('div', 'day-divider', dateLabel(m.day))); previousDay = m.day; }
      if (m.system) { const sys = node('div', 'system-message'); sys.dataset.messageIndex = String(start + offset); highlighted(sys, m.text); target.append(sys); continue; }
      const outgoing = m.sender === chat.viewAs, bubble = node('article', 'message' + (outgoing ? ' outgoing' : '')); bubble.setAttribute('aria-label', `${m.sender}, ${m.day} ${m.time}`);
      bubble.dataset.messageIndex = String(start + offset);
      const emojiCount = m.attachment ? 0 : C.emojiOnlyCount(m.text);
      if (emojiCount) { bubble.classList.add('emoji-message'); bubble.dataset.emojiCount = String(emojiCount); }
      if (m.attachment?.kind === 'sticker') bubble.classList.add('sticker-message');
      if (!outgoing) bubble.append(node('div', 'message-sender', m.sender));
      if (m.attachment) bubble.append(attachmentCard(chat, m));
      const content = node('div', 'message-content'); highlighted(content, m.attachment ? m.attachment.caption : m.text); if (content.textContent) bubble.append(content);
      bubble.append(node('div', 'message-meta', m.time)); target.append(bubble);
    }
    $('page-label').textContent = count ? `${(start + 1).toLocaleString()}–${Math.min(start + state.perPage, count).toLocaleString()} of ${count.toLocaleString()}` : '0 messages';
    $('older-button').disabled = state.page === 0; $('newer-button').disabled = state.page >= pages - 1; $('latest-button').disabled = !chat.messages.length; $('export-text-button').disabled = !count;
    $('message-area').scrollTop = scrollBottom ? $('message-area').scrollHeight : 0;
    updateScrollBottomButton(); updateSearchNavigation();
  }
  function updateScrollBottomButton() {
    const area = $('message-area'), hasLater = Boolean(state.query || $('sender-filter').value || $('date-from').value || $('date-to').value || $('type-filter').value) || state.page < Math.ceil(state.filtered.length / state.perPage) - 1 || area.scrollTop + area.clientHeight < area.scrollHeight - 80;
    $('scroll-bottom-button').hidden = !hasLater || $('conversation').hidden;
  }
  function goToBottom() {
    resetFilters(false); $('message-search-bar').hidden = true; applyFilters(true);
    const count = state.filtered.length;
    $('message-area').scrollTo({ top: $('message-area').scrollHeight, behavior: 'auto' });
    logEvent('messages.go_to_bottom', { page: state.page + 1, pages: Math.max(1, Math.ceil(count / state.perPage)) });
  }
  async function mediaURL(chat, a) {
    if (chat.disposed) throw Error('This chat was removed from the session.');
    const key = mediaCacheKey(chat, a), cached = state.urls.get(key); if (cached) { state.urls.delete(key); state.urls.set(key, cached); return cached.url; }
    const bytes = chat.demoFiles?.get(a.name) || (a.sourceFile ? await library.attachment(a) : a.entry && await C.extractEntry(chat.zip, a.entry));
    if (!bytes) throw Error('This attachment was not included in the export.');
    if (chat.disposed) throw Error('This chat was removed from the session.');
    const completed = state.urls.get(key); if (completed) return completed.url;
    const size = bytes instanceof Blob ? bytes.size : bytes.byteLength;
    for (const [oldKey, old] of state.urls) {
      if (state.mediaBytes + size <= 180 * 1024 ** 2) break;
      if (!old.pinned) { URL.revokeObjectURL(old.url); state.mediaBytes -= old.size; state.urls.delete(oldKey); }
    }
    if (state.mediaBytes + size > 180 * 1024 ** 2) throw Error('Close the current media preview before opening another large attachment.');
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: a.mime });
    const url = URL.createObjectURL(blob); state.urls.set(key, { url, size }); state.mediaBytes += size; return url;
  }
  async function showAttachment(chat, m) {
    const a = m.attachment;
    const generation = state.generation;
    try {
      busy(true, `Checking ${a.name} on your device`); await yieldUI(); const url = await mediaURL(chat, a); if (generation !== state.generation) return;
      const cache = state.urls.get(mediaCacheKey(chat, a)); if (cache) cache.pinned = true;
      let preview;
      if (a.kind === 'image' || a.kind === 'sticker') { preview = node('img', 'media-display' + (a.kind === 'sticker' ? ' sticker-display' : '')); preview.src = url; preview.alt = a.caption || a.name; }
      else if (a.kind === 'video' || a.kind === 'audio') { preview = node(a.kind, 'media-display'); preview.controls = true; preview.preload = 'metadata'; preview.src = url; }
      else preview = para('This document is available to download. Documents are not executed or embedded in the viewer.');
      if (preview.tagName === 'IMG' || preview.tagName === 'VIDEO' || preview.tagName === 'AUDIO') preview.addEventListener('error', () => toast('This media format could not be displayed. Download it and open it with a compatible local app.'));
      const link = node('a', 'primary-button', 'Download attachment'); link.href = url; link.download = a.name.replace(/[^\p{L}\p{N}_.() -]/gu, '_');
      const actions = node('div', 'modal-actions'); actions.append(link);
      link.dataset.action = 'attachment-download'; logEvent('attachment.open', { type: a.kind });
      if (a.kind === 'image' || a.kind === 'sticker') {
        actions.append(button(a.kind === 'sticker' ? 'Show as photo' : 'Show as sticker', () => {
          const kind = a.kind === 'sticker' ? 'image' : 'sticker';
          for (const item of chat.messages) if (item.attachment?.name === a.name && item.attachment.sourceFile === a.sourceFile && item.attachment.entryName === a.entryName) item.attachment.kind = kind;
          closeModal(); applyFilters(); if (!$('media-panel').hidden) renderGallery();
        }));
      }
      openModal(a.name, [preview, para(`${m.sender || 'System'} · ${dateLabel(m.day)} · ${m.time}`, 'file-details'), actions]);
      modalCleanup = () => { if (cache) cache.pinned = false; if (preview.pause) { preview.pause(); preview.removeAttribute('src'); preview.load(); } };
    } catch (e) { toast(e.message || 'This attachment could not be read.'); }
    finally { busy(false); }
  }
  function renderGallery() {
    const chat = activeChat(); if (!chat) return;
    const type = $('gallery-type').value, all = chat.messages.filter(m => m.attachment && (!type || m.attachment.kind === type));
    $('gallery-count').textContent = `${all.length.toLocaleString()} attachment${all.length === 1 ? '' : 's'} · current chat`;
    const box = $('gallery-items'); box.replaceChildren();
    pruneThumbnails();
    for (const m of all.slice(0, state.galleryLimit)) { const row = node('div', 'gallery-item'); row.append(attachmentCard(chat, m, true), para(`${m.sender || 'System'} · ${dateLabel(m.day)}`)); box.append(row); }
    if (!all.length) box.append(para('No attachments in this view. Export the chat with media to include photos, videos, audio, and documents.', 'modal-note'));
    $('gallery-more').hidden = all.length <= state.galleryLimit;
  }
  function chatDetails() {
    const chat = activeChat(); if (!chat) return;
    const label = node('label', '', 'Conversation name'), input = node('input'); input.value = chat.name; input.maxLength = 100; input.setAttribute('aria-label', 'Conversation name'); input.style.width = '100%'; label.append(input);
    const actions = node('div', 'modal-actions'); actions.append(button('Save changes', async () => { try { const name = input.value.trim() || chat.name; if (!chat.sample) await library.preferences(chat.id, { name }); chat.name = name; closeModal(); await openChat(chat.id); } catch (e) { toast(e.message); } }, 'primary-button'));
    openModal('Conversation details', [label, heading('Participants'), para(chat.participants.join(', ') || 'System messages only'), heading('Saved history'), para(`${(chat.count ?? chat.messages.length).toLocaleString()} messages · ${chat.messages.filter(m => m.attachment).length.toLocaleString()} attachments. Date order is selected before importing, in the export guide.`), para('New exports update this saved conversation. Emoji artwork uses your device’s fonts. Stickers use original exported images. “View as” changes alignment; exports do not contain delivery or read receipts.', 'modal-note'), actions, button('Backup, storage & undo import', storageSettings)]);
  }
  function downloadText() {
    const chat = activeChat(), messages = state.query ? state.searchMatches.map(i => state.filtered[i]) : state.filtered; if (!chat || !messages.length) { toast('No matching messages to export.'); return; }
    const content = messages.map(m => `${m.day} ${m.time} - ${m.sender ? m.sender + ': ' : ''}${m.text}`).join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })), a = node('a'); a.href = url; a.download = (chat.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'chat') + '-filtered.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Exported the visible search and filter results as plain text.');
    logEvent('messages.export', { messages: messages.length, queryPresent: Boolean(state.query) });
  }
  function chatName(filename, transcriptName) { let n = C.basename(transcriptName || filename).replace(/\.txt$/i, ''); if (/^_?chat$/i.test(n)) n = C.basename(filename).replace(/\.zip$/i, ''); return n.replace(/^WhatsApp Chat (?:with |— |– |- )?/i, '').trim() || 'Imported conversation'; }
  async function importFiles(files) {
    if (state.busy) return; if (!library) { toast('Set up or unlock a library before importing your chats.'); await exitSample(); return; }
    const chosen = [...files]; $('file-input').value = ''; if (!chosen.length) return;
    const errors = [], results = []; let lastId;
    state.importing = true; state.cancelImport = false;
    try {
      busy(true, 'Reading exports on this PC');
      for (const file of chosen) {
        if (state.cancelImport) break;
        try {
          $('busy-detail').textContent = 'Reading ' + file.name; await yieldUI();
          const items = await library.prepare(file, defaultOrder);
          for (const item of items) {
            if (state.cancelImport) break;
            if (item.parsed.ambiguous) { busy(false); const order = await chooseDateOrder(item); if (!order) continue; item.parsed = await window.DMKProcessor.run('parse', { text: item.raw, options: { dateOrder: order, files: item.media } }); busy(true, 'Saving the selected date format'); }
            let target = item.exact;
            if (!target && item.possible.length) { busy(false); target = await chooseImportTarget(item); if (target === undefined) continue; busy(true, 'Updating the saved history'); }
            const result = await library.import(item, target); logEvent('chat.import', { messages: result.count, updated: Boolean(result.updated), duplicate: Boolean(result.duplicate) }); results.push(result); lastId = result.id;
          }
        } catch (e) { if (e.name === 'AbortError') { state.cancelImport = true; break; } errors.push(file.name + ': ' + e.message); logEvent('chat.import.failed', { category: 'processing' }); }
      }
      state.chats.forEach(releaseChat); state.chats = library.list(); state.active = null; renderSidebar(); if (lastId) await openChat(lastId);
    } finally { state.importing = false; busy(false); }
    if (state.cancelImport) { logEvent('chat.import.cancel'); toast('Import stopped. Any conversations already saved are still in your library.'); }
    if (errors.length) { const list = node('ul'); errors.forEach(e => list.append(node('li', '', e))); openModal('Import results', [para(`${results.length} conversation(s) saved or updated. Any failed import left its earlier saved history intact.`), list, button('Close', closeModal, 'primary-button')]); }
    else if (results.length) { const r = results[results.length - 1]; toast(r.duplicate ? r.name + ' is already up to date.' : r.updated ? `${r.name} updated: ${r.previousCount.toLocaleString()} → ${r.count.toLocaleString()} messages. ${r.retained ? r.retained.toLocaleString() + ' older messages kept.' : 'Overlapping history matched.'}` : `${r.name} saved permanently with ${r.count.toLocaleString()} messages.`); }
  }
  async function loadDemo() {
    if (state.chats.some(c => c.sample)) { openChat(state.chats.find(c => c.sample).id); return; }
    const examples = [
      { name: 'Weekend plans', text: '18/10/2026, 10:15 - Messages in this sample are fictional.\n18/10/2026, 10:15 - Ayesha: A little escape this weekend? 🌿\n18/10/2026, 10:17 - You: I’m in. Somewhere with good coffee and no notifications.\n18/10/2026, 10:18 - Hamza: So… the mountains?\n18/10/2026, 10:19 - Ayesha: Exactly what I was thinking!\n18/10/2026, 10:21 - You: Saved the route. We can leave at 7 on Saturday.\n18/10/2026, 10:23 - Hamza: That gives us the whole morning. Perfect.\n19/10/2026, 09:10 - Ayesha: IMG-20261019-WA0001.png (file attached)\nA little inspiration for the trip.\n19/10/2026, 09:11 - You: That view alone is worth the early start.\n19/10/2026, 09:12 - Hamza: I’ll bring the camera 📷\n19/10/2026, 09:13 - Ayesha: And I’ll bring snacks. Priorities.\n19/10/2026, 09:14 - You: It’s a plan. See you both Saturday!\n19/10/2026, 09:15 - Ayesha: ❤️\n19/10/2026, 09:16 - Hamza: 😂😂\n19/10/2026, 09:17 - You: 👍🏽' },
      { name: 'Design circle', text: '[17/10/2026, 14:05:00] Sara: I’ve shared a few ideas for the reading corner.\n[17/10/2026, 14:07:00] You: The green palette feels calmer.\n[17/10/2026, 14:08:00] Sara: Agreed. Let’s keep the typography simple too.\n[18/10/2026, 11:02:00] You: One clear action per screen.\nAnd a little room to breathe.\n[18/10/2026, 11:05:00] Sara: That’s the direction. Thanks!' },
      { name: 'Notes to self', text: '16/10/2026, 21:04 - You: Things worth keeping:\n• Make time for old friends\n• Print a few photos\n• Back up the family chats\n17/10/2026, 08:30 - You: A small reminder: the ordinary moments are the ones we miss.\n19/10/2026, 12:15 - You: Keep a copy of the memories. Keep control of the data.' }
    ];
    const canvas = document.createElement('canvas'); canvas.width = 560; canvas.height = 330; const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#dfeae1'; ctx.fillRect(0, 0, 560, 330); ctx.fillStyle = '#fff7d6'; ctx.beginPath(); ctx.arc(425, 75, 36, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#9db5a0'; ctx.beginPath(); ctx.moveTo(0, 220); ctx.lineTo(140, 70); ctx.lineTo(300, 235); ctx.lineTo(420, 140); ctx.lineTo(560, 250); ctx.lineTo(560, 330); ctx.lineTo(0, 330); ctx.fill();
    ctx.fillStyle = '#4e7861'; ctx.beginPath(); ctx.moveTo(0, 270); ctx.lineTo(180, 170); ctx.lineTo(390, 290); ctx.lineTo(560, 210); ctx.lineTo(560, 330); ctx.lineTo(0, 330); ctx.fill();
    const imageBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    for (const e of examples) { const parsed = C.parseChat(e.text, { dateOrder: 'DMY' }); const chat = { ...parsed, id: crypto.randomUUID(), name: e.name, filename: 'Fictional sample', raw: e.text, zip: null, files: null, demoFiles: new Map(), sourceSize: 0, color: state.chats.length % 5, sample: true, disposed: false, viewAs: 'You' }; if (e.name === 'Weekend plans' && imageBlob) chat.demoFiles.set('IMG-20261019-WA0001.png', imageBlob); state.chats.push(chat); }
    const first = state.chats.find(c => c.sample); if (imageBlob) { const m = first.messages.find(m => m.attachment); await mediaURL(first, m.attachment); }
    openChat(first.id);
  }
  async function previewSample() {
    if (state.busy || vault) return;
    state.sampleMode = true; $('app').hidden = false; $('app').inert = false; $('vault-gate').hidden = true; $('demo-exit').hidden = false;
    await loadDemo(); updateLibraryHealth(); logEvent('sample.open');
  }
  async function exitSample() {
    if (vault) return;
    state.chats.forEach(releaseChat); state.chats = []; state.filtered = []; state.active = null; state.sampleMode = false; $('demo-exit').hidden = true;
    $('messages').replaceChildren(); $('gallery-items').replaceChildren(); pruneThumbnails(true); renderSidebar(); await refreshGate(); updateLibraryHealth();
  }
  $('import-button').addEventListener('click', () => $('file-input').click()); $('add-button').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => importFiles(e.target.files));
  $('drop-zone').addEventListener('dragover', e => { e.preventDefault(); $('drop-zone').classList.add('dragging'); });
  $('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragging'));
  $('drop-zone').addEventListener('drop', e => { e.preventDefault(); $('drop-zone').classList.remove('dragging'); importFiles(e.dataTransfer.files); });
  document.addEventListener('dragover', e => e.preventDefault()); document.addEventListener('drop', e => e.preventDefault());
  $('privacy-nav').addEventListener('click', privacyDetails); $('privacy-top').addEventListener('click', privacyDetails);
  $('help-button').addEventListener('click', exportGuide); $('export-guide').addEventListener('click', exportGuide); $('clear-button').addEventListener('click', lockLibrary); $('demo-button').addEventListener('click', () => loadDemo().catch(e => toast(e.message)));
  $('theme-button').addEventListener('click', () => { const dark = document.documentElement.classList.toggle('dark'); if (vault) vault.change(index => { index.settings.theme = dark ? 'dark' : 'light'; }).catch(e => toast(e.message)); $('theme-button').replaceChildren(icon(dark ? 'sun' : 'moon')); $('theme-button').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`); });
  $('chat-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSidebar, 180); });
  $('all-tab').addEventListener('click', () => { state.mediaOnly = false; $('all-tab').classList.add('active'); $('media-tab').classList.remove('active'); $('all-tab').setAttribute('aria-pressed', 'true'); $('media-tab').setAttribute('aria-pressed', 'false'); renderSidebar(); });
  $('media-tab').addEventListener('click', () => { state.mediaOnly = true; $('media-tab').classList.add('active'); $('all-tab').classList.remove('active'); $('media-tab').setAttribute('aria-pressed', 'true'); $('all-tab').setAttribute('aria-pressed', 'false'); renderSidebar(); });
  $('chats-nav').addEventListener('click', () => { if (matchMedia('(max-width: 760px)').matches) $('app').classList.toggle('mobile-library'); else { $('welcome').hidden = false; $('conversation').hidden = true; $('media-panel').hidden = true; state.active = null; renderSidebar(); } });
  $('back-button').addEventListener('click', () => $('app').classList.add('mobile-library'));
  $('view-as').addEventListener('change', () => { const chat = activeChat(); if (chat) { chat.viewAs = $('view-as').value; if (!chat.sample) library.preferences(chat.id, { viewAs: chat.viewAs }).catch(e => toast(e.message)); renderMessages(false); } });
  $('search-toggle').addEventListener('click', () => { $('message-search-bar').hidden = !$('message-search-bar').hidden; if (!$('message-search-bar').hidden) $('message-search').focus(); });
  $('close-search').addEventListener('click', () => { $('message-search-bar').hidden = true; $('message-search').value = ''; applyFilters(true); });
  $('message-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => applyFilters(), 180); });
  $('search-previous').addEventListener('click', () => jumpToSearchMatch(-1)); $('search-next').addEventListener('click', () => jumpToSearchMatch(1));
  $('message-area').addEventListener('scroll', updateScrollBottomButton, { passive: true });
  $('scroll-bottom-button').addEventListener('click', goToBottom);
  $('filter-button').addEventListener('click', () => { $('filters').hidden = !$('filters').hidden; $('filter-button').setAttribute('aria-expanded', String(!$('filters').hidden)); });
  ['sender-filter', 'date-from', 'date-to', 'type-filter'].forEach(id => $(id).addEventListener('change', () => applyFilters()));
  $('reset-filters').addEventListener('click', () => resetFilters()); $('older-button').addEventListener('click', () => { state.page--; renderMessages(); }); $('newer-button').addEventListener('click', () => { state.page++; renderMessages(); }); $('latest-button').addEventListener('click', goToBottom);
  $('gallery-button').addEventListener('click', () => { $('media-panel').hidden = false; $('gallery-type').value = ''; state.galleryLimit = 40; renderGallery(); }); $('gallery-close').addEventListener('click', () => { $('media-panel').hidden = true; }); $('gallery-type').addEventListener('change', () => { state.galleryLimit = 40; renderGallery(); }); $('gallery-more').addEventListener('click', () => { state.galleryLimit += 40; renderGallery(); });
  $('chat-info-button').addEventListener('click', chatDetails); $('export-text-button').addEventListener('click', downloadText);
  $('remove-chat-button').addEventListener('click', deleteSavedChat);
  document.addEventListener('keydown', e => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('modal').open) { e.preventDefault(); if (matchMedia('(max-width: 760px)').matches) $('app').classList.add('mobile-library'); $('chat-search').focus(); } if (e.key === 'Escape') $('media-panel').hidden = true; });
  $('storage-button').addEventListener('click', storageSettings);
  $('choose-folder').addEventListener('click', chooseFolder);
  $('choose-browser').addEventListener('click', chooseBrowser);
  $('vault-form').addEventListener('submit', unlockLibrary);
  $('gate-demo').addEventListener('click', () => previewSample().catch(e => toast(e.message)));
  $('demo-exit').addEventListener('click', exitSample); $('gate-guide').addEventListener('click', exportGuide);
  $('restore-with-key').addEventListener('change', refreshGate);
  $('cancel-import').addEventListener('click', () => { state.cancelImport = true; window.DMKProcessor.cancel(); $('busy-detail').textContent = 'Stopping after the current save finishes'; });
  $('forgot-password-button').addEventListener('click', forgotPassword);
  $('restore-backup-button').addEventListener('click', () => { if (!selectedStore) { gateError('Choose an empty PC folder or browser storage first.'); return; } $('restore-backup-input').click(); });
  $('restore-backup-input').addEventListener('change', () => { restoringBackup = $('restore-backup-input').files[0] || null; $('restore-backup-input').value = ''; refreshGate(); });
  window.addEventListener('pagehide', () => { state.generation++; state.chats.forEach(releaseChat); state.chats = []; state.filtered = []; state.active = null; if (vault) { vault.closed = true; vault.key = null; vault.index = null; } if (library) library.cache.clear(); vault = null; library = null; $('messages').replaceChildren(); $('gallery-items').replaceChildren(); pruneThumbnails(true); cleanModal(); $('chat-list').replaceChildren(); $('app').hidden = true; $('app').inert = true; });
  window.addEventListener('pageshow', e => { if (e.persisted) bootVault(); });
  for (const link of document.querySelectorAll('a[href="dmk-chat-vault-pc.zip"]')) { link.hidden = true; link.removeAttribute('href'); }
  const desktop = window.DMKDesktop;
  let heartbeatTimer;
  $('exit-app').hidden = !desktop?.token;
  $('gate-exit-app').hidden = !desktop?.token;
  async function closeDesktop() {
    try { if (vault) await lockLibrary('exit'); await logQueue; const response = await fetch('/__dmk_shutdown', { method: 'POST', headers: { 'X-DMK-Token': desktop.token } }); if (!response.ok) throw Error('Could not close the local launcher.'); clearInterval(heartbeatTimer); desktop.closed = true; toast('Chat Vault is closed. You can close this window.'); } catch (e) { toast(e.message); }
  }
  $('exit-app').addEventListener('click', closeDesktop); $('gate-exit-app').addEventListener('click', closeDesktop);
  if (desktop?.token) {
    const windowId = crypto.randomUUID(), headers = { 'X-DMK-Token': desktop.token, 'X-DMK-Window': windowId };
    const heartbeat = () => fetch('/__dmk_heartbeat', { method: 'POST', headers }).catch(() => {});
    heartbeat(); heartbeatTimer = setInterval(heartbeat, 30000);
    window.addEventListener('pageshow', event => { if (event.persisted && !desktop.closed) { heartbeat(); heartbeatTimer = setInterval(heartbeat, 30000); } });
    window.addEventListener('pagehide', () => { clearInterval(heartbeatTimer); if (!desktop.closed) fetch('/__dmk_leave', { method: 'POST', headers, keepalive: true }).catch(() => {}); });
  }
  for (const type of ['pointerdown', 'keydown', 'scroll', 'touchstart']) document.addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
  setInterval(() => { if (vault && !state.busy && Date.now() - lastActivity > (vault.index.settings.idleMinutes || 10) * 60000) { lastActivity = Date.now(); lockLibrary('idle').then(() => toast('Library locked after inactivity.')); } }, 15000);
  document.addEventListener('click', event => {
    const control = event.target.closest?.('button,a'); if (!control || control.disabled) return;
    const name = control.id || control.dataset.action || 'dialog-action'; logEvent('ui.activate', { control: name });
  }, true);
  document.addEventListener('change', event => {
    const control = event.target; if (control.id && control.type !== 'password') logEvent('ui.change', { control: control.id });
  });
  window.addEventListener('error', () => { logEvent('runtime.error', { category: 'javascript' }); });
  window.addEventListener('unhandledrejection', () => { logEvent('runtime.error', { category: 'promise' }); });
  window.addEventListener('resize', updateScrollBottomButton);
  window.addEventListener('dmk-processing-status', () => { if (window.DMKProcessor.mode === 'compatibility') toast('Background processing is unavailable. Imports will use compatibility mode.'); });
  document.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'End' && activeChat() && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) { event.preventDefault(); goToBottom(); } if (event.key === 'Enter' && event.target.id === 'message-search' && state.searchMatches.length) { event.preventDefault(); jumpToSearchMatch(event.shiftKey ? -1 : 1); } });
  renderSidebar(); bootVault();
})();
