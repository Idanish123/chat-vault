/* Durable encrypted storage. No key/password is written to disk. */
(function (root) {
  'use strict';
  const te = new TextEncoder(), td = new TextDecoder(), ROUNDS = 600000, MAX_RECORD = 300 * 1024 ** 2;
  const validFile = n => n === 'vault.json' || n === 'activity.bin' || /^(?:src|chat)-[a-f0-9-]{36}\.bin$/.test(n);
  const PUBLIC_LOG = 'activity.jsonl';
  const MAX_LOG_BYTES = 1024 * 1024;
  const logDetailKeys = new Set(['count','messages','bytes','updated','duplicate','matches','queryPresent','senderFilter','dateFilter','typeFilter','direction','result','total','page','pages','storage','operation','control','category','reason','minutes','type','events']);
  function sanitizeEvent(event) {
    if (!event || !/^[a-z0-9_.-]{1,80}$/.test(event.action) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw Error('Invalid activity event.');
    const details = {};
    for (const [key, value] of Object.entries(event.details || {})) if (logDetailKeys.has(key) && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(value))) details[key] = value;
    return { at: new Date(event.at).toISOString(), action: event.action, details };
  }
  const bytes = x => x instanceof Uint8Array ? x : new Uint8Array(x);
  const b64 = b => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function derive(password, salt, extractable = false) {
    const material = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ROUNDS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
  }
  const importDataKey = raw => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const credentialAAD = (header, role) => 'DMKChatVault/v1/' + header.id + '/' + role + '-key';
  function normalizeRecoveryKey(value) {
    const normalized = String(value).replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-F0-9]{64}$/.test(normalized)) throw Error('Enter the complete 64-character recovery key. Spaces and hyphens are optional.');
    return normalized;
  }
  async function passwordDataKey(header, password) {
    const wrappingKey = await derive(password, unb64(header.salt));
    if (!header.keyScheme) return wrappingKey;
    const raw = await unseal(wrappingKey, unb64(header.passwordKey), credentialAAD(header, 'password'));
    try { if (raw.length !== 32) throw Error('Invalid data key.'); return await importDataKey(raw); } finally { raw.fill(0); }
  }
  async function readIndex(header, key) {
    const index = validateIndex(JSON.parse(td.decode(await unseal(key, unb64(header.index), 'DMKChatVault/v1/' + header.id + '/index'))));
    if (index.revision !== header.revision) throw Error('Revision mismatch');
    return index;
  }
  async function recoveryDataKey(header, secret) {
    if (!header.recovery) throw Error('Recovery was not set up for this library.');
    const raw = await unseal(await derive(normalizeRecoveryKey(secret), unb64(header.recovery.salt)), unb64(header.recovery.key), credentialAAD(header, 'recovery'));
    try { if (raw.length !== 32) throw Error('Invalid recovery information.'); return await importDataKey(raw); } finally { raw.fill(0); }
  }
  async function seal(key, data, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12)), cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, data));
    const result = new Uint8Array(iv.length + cipher.length); result.set(iv); result.set(cipher, 12); return result;
  }
  async function unseal(key, data, aad) {
    data = bytes(data); if (data.length < 28 || data.length > MAX_RECORD + 28) throw Error('Invalid encrypted record size.');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: te.encode(aad) }, key, data.subarray(12)));
  }
  class BrowserStore {
    constructor(db) { this.db = db; this.kind = 'browser'; }
    static async open() {
      if (!root.indexedDB) throw Error('Local storage is unavailable. Open the PC edition in normal Chrome or Edge.');
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('dmk-chat-vault-permanent-v1', 1); r.onupgradeneeded = () => { r.result.createObjectStore('records'); r.result.createObjectStore('preferences'); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return new BrowserStore(db);
    }
    transact(store, mode, fn) { return new Promise((resolve, reject) => { const t = this.db.transaction(store, mode), request = fn(t.objectStore(store)); let result; if (request) request.onsuccess = () => { result = request.result; }; t.oncomplete = () => resolve(result); t.onerror = t.onabort = () => reject(t.error || Error('Local save failed.')); }); }
    async get(name) { if (!validFile(name) && name !== PUBLIC_LOG) throw Error('Invalid vault record.'); return this.transact('records', 'readonly', s => s.get(name)); }
    async put(name, value) { if (!validFile(name) && name !== PUBLIC_LOG) throw Error('Invalid vault record.'); return this.transact('records', 'readwrite', s => s.put(bytes(value), name)); }
    async remove(name) { if (!validFile(name) && name !== PUBLIC_LOG) throw Error('Invalid vault record.'); return this.transact('records', 'readwrite', s => s.delete(name)); }
    async list() { return this.transact('records', 'readonly', s => s.getAllKeys()); }
    async preference(key, value) { return value === undefined ? this.transact('preferences', 'readonly', s => s.get(key)) : this.transact('preferences', 'readwrite', s => s.put(value, key)); }
  }
  class FolderStore {
    constructor(handle) { this.handle = handle; this.kind = 'folder'; }
    async permission() { const p = { mode: 'readwrite' }; return await this.handle.queryPermission(p) === 'granted' || await this.handle.requestPermission(p) === 'granted'; }
    async get(name) { if (!validFile(name) && name !== PUBLIC_LOG) throw Error('Invalid vault record.'); try { const f = await (await this.handle.getFileHandle(name)).getFile(); if (f.size > MAX_RECORD + 1024) throw Error('Vault record is too large.'); return new Uint8Array(await f.arrayBuffer()); } catch (e) { if (e.name === 'NotFoundError') return undefined; throw e; } }
    async put(name, value) { if (!validFile(name) && name !== PUBLIC_LOG) throw Error('Invalid vault record.'); const h = await this.handle.getFileHandle(name, { create: true }), w = await h.createWritable(); try { await w.write(value); await w.close(); } catch (e) { try { await w.abort(); } catch {} throw e; } }
    async remove(name) { if (!validFile(name) && name !== PUBLIC_LOG) throw Error('Invalid vault record.'); try { await this.handle.removeEntry(name); } catch (e) { if (e.name !== 'NotFoundError') throw e; } }
    async list() { const names = []; for await (const [name] of this.handle.entries()) if (validFile(name)) names.push(name); return names; }
  }
  function validateHeader(h) {
    if (!h || h.format !== 'DMKChatVault' || h.version !== 1 || h.rounds !== ROUNDS || !/^[a-f0-9-]{36}$/.test(h.id) || typeof h.salt !== 'string' || unb64(h.salt).length !== 16 || typeof h.index !== 'string' || h.index.length > 16 * 1024 ** 2) throw Error('Unsupported or damaged vault.');
    if (h.keyScheme !== undefined && (h.keyScheme !== 'wrapped-v1' || typeof h.passwordKey !== 'string' || h.passwordKey.length > 128 || unb64(h.passwordKey).length !== 60)) throw Error('Unsupported password protection format.');
    if (h.recovery !== undefined && (h.keyScheme !== 'wrapped-v1' || !h.recovery || typeof h.recovery.salt !== 'string' || h.recovery.salt.length > 32 || unb64(h.recovery.salt).length !== 16 || typeof h.recovery.key !== 'string' || h.recovery.key.length > 128 || unb64(h.recovery.key).length !== 60)) throw Error('Damaged recovery information.');
    return h;
  }
  function validateIndex(i) {
    if (!i || i.version !== 1 || !Array.isArray(i.chats) || i.chats.length > 200 || !i.sources || typeof i.sources !== 'object' || !i.settings) throw Error('Damaged library index.');
    const check = c => { if (!c || !/^[a-f0-9-]{36}$/.test(c.id) || !validFile(c.dataFile) || !c.dataFile.startsWith('chat-') || !Array.isArray(c.sourceFiles) || c.sourceFiles.length > 1200 || c.sourceFiles.some(f => !validFile(f) || !f.startsWith('src-')) || typeof c.name !== 'string' || c.name.length > 200 || !Array.isArray(c.participants) || c.participants.some(p => typeof p !== 'string') || !Number.isInteger(c.count) || c.count < 0 || c.count > 200000) throw Error('Damaged conversation index.'); };
    const ids = new Set(); for (const c of i.chats) { check(c); if (ids.has(c.id)) throw Error('Duplicate conversation identity.'); ids.add(c.id); if (c.previous) { check(c.previous); if (c.previous.previous || c.previous.id !== c.id) throw Error('Damaged previous-import record.'); } }
    for (const [name, source] of Object.entries(i.sources)) if (!validFile(name) || !name.startsWith('src-') || !source || typeof source.filename !== 'string' || typeof source.hash !== 'string') throw Error('Damaged source index.');
    return i;
  }
  class Vault {
    constructor(store, header, key, index) { this.store = store; this.header = header; this.key = key; this.index = index; this.queue = Promise.resolve(); this.closed = false; }
    static async exists(store) { return !!(await store.get('vault.json')); }
    static async hasRecovery(store) {
      const raw = await store.get('vault.json'); if (!raw) return false;
      return Boolean(validateHeader(JSON.parse(td.decode(raw))).recovery);
    }
    static async create(store, password) {
      if (password.length < 12) throw Error('Use a password of at least 12 characters.');
      if (await Vault.exists(store)) throw Error('This location already has a vault. Unlock it instead.');
      const salt = crypto.getRandomValues(new Uint8Array(16)), raw = crypto.getRandomValues(new Uint8Array(32));
      const header = { format: 'DMKChatVault', version: 1, rounds: ROUNDS, id: crypto.randomUUID(), salt: b64(salt), revision: '', keyScheme: 'wrapped-v1' };
      let key;
      try { key = await importDataKey(raw); header.passwordKey = b64(await seal(await derive(password, salt), raw, credentialAAD(header, 'password'))); } finally { raw.fill(0); }
      const index = { version: 1, chats: [], sources: {}, settings: { theme: 'light', active: null } }, v = new Vault(store, header, key, index); await v.saveIndex(index, true); return v;
    }
    static async unlock(store, password) {
      const raw = await store.get('vault.json'); if (!raw) throw Error('No saved vault found here. Create a library first.');
      const h = validateHeader(JSON.parse(td.decode(raw)));
      try { const key = await passwordDataKey(h, password); return new Vault(store, h, key, await readIndex(h, key)); }
      catch { throw Error('Wrong password, or this vault is damaged. Nothing has been changed.'); }
    }
    aad(name) { return 'DMKChatVault/v1/' + this.header.id + '/' + name; }
    async read(name) { if (this.closed) throw Error('Your library is locked.'); const data = await this.store.get(name); if (!data) throw Error('A saved file is missing. Restore an encrypted backup.'); return unseal(this.key, data, this.aad(name)); }
    async write(name, data) { if (this.closed) throw Error('Your library is locked.'); data = bytes(data); if (data.length > MAX_RECORD) throw Error('This record exceeds the storage limit.'); await this.store.put(name, await seal(this.key, data, this.aad(name))); }
    async saveIndex(next, initial = false, credentials = {}) {
      if (this.closed) throw Error('Your library is locked.');
      validateIndex(next);
      const referenced = this.referenced(next); for (const name of Object.keys(next.sources)) if (!referenced.has(name)) delete next.sources[name];
      if (!initial) { const disk = JSON.parse(td.decode(await this.store.get('vault.json'))); if (disk.revision !== this.header.revision) throw Error('This vault changed in another window. Lock and reopen it before updating.'); }
      const revision = crypto.randomUUID(); next = { ...next, revision }; const encoded = te.encode(JSON.stringify(next)); if (encoded.length > 8 * 1024 ** 2) throw Error('The library index exceeds its 8 MB safety limit. No history was replaced.'); const header = { ...this.header, ...credentials, revision, index: b64(await seal(this.key, encoded, this.aad('index'))) };
      validateHeader(header);
      await this.store.put('vault.json', te.encode(JSON.stringify(header))); this.header = header; this.index = next;
    }
    transaction(fn) {
      const work = async () => { if (this.closed) throw Error('Your library is locked.'); if (root.navigator?.locks) return navigator.locks.request('dmk-vault-' + this.header.id, () => fn(this)); return fn(this); };
      const p = this.queue.then(work, work); this.queue = p.catch(() => {}); return p;
    }
    async change(fn) { return this.transaction(async () => { const next = structuredClone(this.index); await fn(next); validateIndex(next); await this.saveIndex(next); }); }
    async credentialMaterial(currentPassword) {
      // Only transient key bytes are extractable, including during an in-place upgrade of an older vault.
      try {
        const key = await passwordDataKey(this.header, currentPassword); await readIndex(this.header, key);
        if (this.header.keyScheme) return unseal(await derive(currentPassword, unb64(this.header.salt)), unb64(this.header.passwordKey), credentialAAD(this.header, 'password'));
        return new Uint8Array(await crypto.subtle.exportKey('raw', await derive(currentPassword, unb64(this.header.salt), true)));
      } catch { throw Error('The current password is incorrect, or the vault is damaged. Nothing has been changed.'); }
    }
    async passwordCredentials(raw, password) {
      if (typeof password !== 'string' || password.length < 12) throw Error('Use a new password of at least 12 characters.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      return { keyScheme: 'wrapped-v1', salt: b64(salt), passwordKey: b64(await seal(await derive(password, salt), raw, credentialAAD(this.header, 'password'))) };
    }
    async changePassword(currentPassword, newPassword) {
      if (typeof newPassword !== 'string' || newPassword.length < 12) throw Error('Use a new password of at least 12 characters.');
      if (currentPassword === newPassword) throw Error('Choose a password different from your current password.');
      return this.transaction(async () => {
        const raw = await this.credentialMaterial(currentPassword);
        try { const next = structuredClone(this.index); next.settings.credentialsChangedAt = new Date().toISOString(); await this.saveIndex(next, false, await this.passwordCredentials(raw, newPassword)); }
        finally { raw.fill(0); }
      });
    }
    async setupRecovery(currentPassword) {
      return this.transaction(async () => {
        const raw = await this.credentialMaterial(currentPassword);
        const random = crypto.getRandomValues(new Uint8Array(32)), salt = crypto.getRandomValues(new Uint8Array(16));
        const secret = Array.from(random, n => n.toString(16).padStart(2, '0')).join('').toUpperCase(); random.fill(0);
        try {
          const credentials = this.header.keyScheme ? {} : await this.passwordCredentials(raw, currentPassword);
          credentials.recovery = { salt: b64(salt), key: b64(await seal(await derive(secret, salt), raw, credentialAAD(this.header, 'recovery'))) };
          const next = structuredClone(this.index); next.settings.recoveryConfirmed = false; next.settings.credentialsChangedAt = new Date().toISOString();
          await this.saveIndex(next, false, credentials);
          return secret.match(/.{8}/g).join('-');
        } finally { raw.fill(0); }
      });
    }
    static async resetPassword(store, recoveryKey, newPassword) {
      if (typeof newPassword !== 'string' || newPassword.length < 12) throw Error('Use a new password of at least 12 characters.');
      const h = validateHeader(JSON.parse(td.decode(await store.get('vault.json'))));
      if (!h.recovery) throw Error('Recovery was not set up for this library. Unlock with the current password to create a recovery key.');
      const secret = normalizeRecoveryKey(recoveryKey); let raw, v;
      try {
        raw = await unseal(await derive(secret, unb64(h.recovery.salt)), unb64(h.recovery.key), credentialAAD(h, 'recovery'));
        if (raw.length !== 32) throw Error('Invalid data key.');
        const key = await importDataKey(raw); v = new Vault(store, h, key, await readIndex(h, key));
      } catch { if (raw) raw.fill(0); throw Error('The recovery key is incorrect, or this vault is damaged. Nothing has been changed.'); }
      try {
        await v.transaction(async () => { const next = structuredClone(v.index); next.settings.credentialsChangedAt = new Date().toISOString(); await v.saveIndex(next, false, await v.passwordCredentials(raw, newPassword)); });
        try { await v.appendLog({ at: new Date().toISOString(), action: 'vault.password.reset', details: {} }); v.auditSaved = true; } catch { v.auditSaved = false; }
      }
      finally { raw.fill(0); await v.lock(); }
      return { auditSaved: v.auditSaved };
    }
    referenced(index = this.index) { const names = new Set(['vault.json']); for (const c of index.chats) for (const r of [c, c.previous].filter(Boolean)) { names.add(r.dataFile); for (const f of r.sourceFiles) names.add(f); } return names; }
    async assertCurrent() { if (this.closed) throw Error('Your library is locked.'); const raw = await this.store.get('vault.json'); if (!raw || JSON.parse(td.decode(raw)).revision !== this.header.revision) throw Error('This vault changed in another window. Lock and reopen it before updating.'); }
    async cleanup() { await this.assertCurrent(); const names = this.referenced(); names.add('activity.bin'); for (const name of await this.store.list()) if (!names.has(name)) await this.store.remove(name); }
    async backup() {
      return this.transaction(async () => {
        await this.assertCurrent();
        if (this.referenced().size > 1200) throw Error('This library exceeds 1,200 backup records. Copy its vault folder directly while the app is closed.');
        const parts = [], manifest = { format: 'DMKChatVaultBackup', version: 1, header: this.header, files: [] }; let total = 0;
        const names = this.referenced(); names.add('activity.bin');
        for (const name of names) if (name !== 'vault.json') {
          const data = await this.store.get(name);
          if (!data) { if (name === 'activity.bin') continue; throw Error('A required library record is missing. Backup cancelled; keep your original exports and restore a known-good backup.'); }
          try { await unseal(this.key, data, this.aad(name)); } catch { throw Error('A library record is damaged. Backup cancelled; restore a known-good backup.'); }
          total += data.byteLength; if (total > 2 * 1024 ** 3) throw Error('This backup exceeds 2 GB. Copy the vault folder directly instead.'); manifest.files.push({ name, size: data.byteLength }); parts.push(new Blob([data]));
        }
        const m = te.encode(JSON.stringify(manifest)), len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, m.length, true); return new Blob([te.encode('DMKVAULT1\n'), len, m, ...parts], { type: 'application/octet-stream' });
      });
    }
    async readLog() {
      const encrypted = await this.store.get('activity.bin'); if (!encrypted) return [];
      const list = JSON.parse(td.decode(await unseal(this.key, encrypted, this.aad('activity.bin'))));
      if (!Array.isArray(list)) throw Error('The activity log is damaged. Existing log data has been preserved.'); return list;
    }
    async appendLog(event) {
      return this.transaction(async () => {
        event = sanitizeEvent(event);
        const list = await this.readLog(); list.push(event);
        let encoded = te.encode(JSON.stringify(list));
        while (encoded.length > MAX_LOG_BYTES && list.length > 1) { list.shift(); encoded = te.encode(JSON.stringify(list)); }
        await this.store.put('activity.bin', await seal(this.key, encoded, this.aad('activity.bin')));
      });
    }
    static async restore(store, file, password, options = {}) {
      const useRecovery = Object.prototype.hasOwnProperty.call(options, 'recoveryKey');
      if (await Vault.exists(store)) throw Error('Restore into an empty folder or an empty browser vault to protect your current library.');
      if (file.size < 14 || file.size > 2.1 * 1024 ** 3 || td.decode(await file.slice(0, 10).arrayBuffer()) !== 'DMKVAULT1\n') throw Error('Not a supported encrypted backup.');
      const n = new DataView(await file.slice(10, 14).arrayBuffer()).getUint32(0, true); if (n > 16 * 1024 ** 2 || n + 14 > file.size) throw Error('Invalid backup manifest.');
      const m = JSON.parse(td.decode(await file.slice(14, 14 + n).arrayBuffer())); if (m.format !== 'DMKChatVaultBackup' || m.version !== 1 || !Array.isArray(m.files) || m.files.length > 1200) throw Error('Invalid backup manifest.');
      const h = validateHeader(m.header); let key, index;
      try { key = useRecovery ? await recoveryDataKey(h, options.recoveryKey) : await passwordDataKey(h, password); index = await readIndex(h, key); } catch { throw Error('Wrong backup password or recovery key, or a damaged backup.'); }
      const v = new Vault(store, h, key, index), needed = v.referenced(), seen = new Set(); let offset = n + 14;
      for (const item of m.files) { if ((!validFile(item.name) && item.name !== 'activity.bin') || item.name === 'vault.json' || seen.has(item.name) || (!needed.has(item.name) && item.name !== 'activity.bin') || !Number.isInteger(item.size) || item.size < 28 || item.size > MAX_RECORD + 28 || offset + item.size > file.size) throw Error('Invalid backup record.'); seen.add(item.name); offset += item.size; }
      if (offset !== file.size || [...needed].some(name => name !== 'vault.json' && !seen.has(name))) throw Error('Backup is incomplete.');
      // Authenticate every record before touching the destination. File/Blob slices are immutable.
      offset = n + 14;
      for (const item of m.files) { await unseal(key, new Uint8Array(await file.slice(offset, offset + item.size).arrayBuffer()), v.aad(item.name)); offset += item.size; }
      return v.transaction(async () => {
        if ((await store.list()).length) throw Error('Restore needs an empty library location. Select a different folder to protect existing files.');
        const written = [];
        try {
          let header = h;
          if (useRecovery) {
            if (typeof password !== 'string' || password.length < 12) throw Error('Choose a new password of at least 12 characters.');
            const raw = await unseal(await derive(normalizeRecoveryKey(options.recoveryKey), unb64(h.recovery.salt)), unb64(h.recovery.key), credentialAAD(h, 'recovery'));
            try {
              header = { ...h, ...await v.passwordCredentials(raw, password) };
              const revision = crypto.randomUUID(); index = { ...index, revision, settings: { ...index.settings, credentialsChangedAt: new Date().toISOString() } };
              header = { ...header, revision, index: b64(await seal(key, te.encode(JSON.stringify(index)), v.aad('index'))) }; v.index = index;
            } finally { raw.fill(0); }
          }
          offset = n + 14;
          for (const item of m.files) { written.push(item.name); await store.put(item.name, new Uint8Array(await file.slice(offset, offset + item.size).arrayBuffer())); offset += item.size; }
          written.push('vault.json'); await store.put('vault.json', te.encode(JSON.stringify(header))); v.header = header; return v;
        } catch (error) {
          let blocked = false; for (const name of written.reverse()) { try { await store.remove(name); } catch { blocked = true; } }
          if (blocked) throw Error('Restore failed and storage access prevented full cleanup. Choose another empty destination. The backup and original library are unchanged.');
          throw error;
        }
      });
    }
    async lock() { await this.queue; this.closed = true; this.key = null; this.index = null; }
  }
  async function readPublicLog(store) {
    const raw = await store.get(PUBLIC_LOG); if (!raw) return [];
    try { const rows = td.decode(raw).split('\n').filter(Boolean).map(line => JSON.parse(line)); return Array.isArray(rows) ? rows : []; } catch { return []; }
  }
  async function appendPublicLog(store, event) {
    const rows = await readPublicLog(store); rows.push(event); let encoded = te.encode(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    while (encoded.length > MAX_LOG_BYTES && rows.length > 1) { rows.shift(); encoded = te.encode(rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
    await store.put(PUBLIC_LOG, encoded);
  }
  const api = { Vault, BrowserStore, FolderStore, seal, unseal, derive, validFile, ROUNDS, readPublicLog, appendPublicLog, sanitizeEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; root.DMKVault = api;
})(typeof window === 'undefined' ? globalThis : window);
