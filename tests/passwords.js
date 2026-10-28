const assert = require('node:assert/strict');
const { Vault, derive, seal, ROUNDS } = require('../app/vault.js');
const te = new TextEncoder(), td = new TextDecoder();
const OLD = 'original password 2026', NEW = 'replacement password 2026', RESET = 'recovered password 2026';
class Store {
  constructor() { this.records = new Map(); this.failHeader = false; }
  async get(name) { return this.records.get(name); }
  async put(name, value) { if (this.failHeader && name === 'vault.json') throw Error('Simulated disk failure'); this.records.set(name, value.slice()); }
  async list() { return [...this.records.keys()]; }
  async remove(name) { this.records.delete(name); }
}
async function legacyVault() {
  const store = new Store(), salt = crypto.getRandomValues(new Uint8Array(16)), key = await derive(OLD, salt);
  const id = crypto.randomUUID(), revision = crypto.randomUUID();
  const index = { version: 1, chats: [], sources: {}, settings: {}, revision };
  const header = { format: 'DMKChatVault', version: 1, rounds: ROUNDS, id, revision, salt: Buffer.from(salt).toString('base64'), index: Buffer.from(await seal(key, te.encode(JSON.stringify(index)), 'DMKChatVault/v1/' + id + '/index')).toString('base64') };
  await store.put('vault.json', te.encode(JSON.stringify(header)));
  return { store, vault: await Vault.unlock(store, OLD) };
}
async function addRecord(vault) {
  const id = crypto.randomUUID(), name = 'chat-' + id + '.bin';
  await vault.write(name, te.encode('saved conversation survives password updates'));
  await vault.change(index => index.chats.push({ id, dataFile: name, sourceFiles: [], name: 'Saved conversation', participants: ['Me'], count: 1 }));
  return name;
}
module.exports = async function passwordTests() {
  const store = new Store(), vault = await Vault.create(store, OLD), record = await addRecord(vault);
  const originalCipher = (await store.get(record)).slice(), initialHeader = (await store.get('vault.json')).slice();
  assert.equal(await Vault.hasRecovery(store), false);
  await assert.rejects(Vault.resetPassword(store, 'A'.repeat(64), RESET), /not set up/);
  await assert.rejects(vault.changePassword('wrong password', NEW), /current password is incorrect/);
  await assert.rejects(vault.changePassword(OLD, 'short'), /12 characters/);
  assert.deepEqual(await store.get('vault.json'), initialHeader, 'invalid credentials never mutate the vault');

  const recovery = await vault.setupRecovery(OLD);
  assert.match(recovery, /^(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/);
  assert.equal(await Vault.hasRecovery(store), true);
  const stale = await Vault.unlock(store, OLD);
  const oldBackup = await vault.backup();
  const headerText = td.decode(await store.get('vault.json'));
  assert.ok(!headerText.includes(recovery.replace(/-/g, '')), 'recovery secret is not stored in plaintext');
  await vault.changePassword(OLD, NEW);
  await assert.rejects(Vault.unlock(store, OLD), /Wrong password/);
  await assert.rejects(stale.changePassword(OLD, RESET), /changed in another window/);
  await stale.lock();
  const changed = await Vault.unlock(store, NEW); await changed.lock();
  assert.deepEqual(await store.get(record), originalCipher, 'changing a password does not rewrite chat data');
  const beforeReset = (await store.get('vault.json')).slice();
  await assert.rejects(Vault.resetPassword(store, 'F'.repeat(64), RESET), /recovery key is incorrect/);
  assert.deepEqual(await store.get('vault.json'), beforeReset);
  store.failHeader = true;
  await assert.rejects(Vault.resetPassword(store, recovery, RESET), /disk failure/);
  assert.deepEqual(await store.get('vault.json'), beforeReset, 'a failed password commit preserves the previous header');
  store.failHeader = false;
  await Vault.resetPassword(store, recovery.toLowerCase().replace(/-/g, ' '), RESET);
  await assert.rejects(Vault.unlock(store, NEW), /Wrong password/);
  await vault.lock();
  const recovered = await Vault.unlock(store, RESET);
  assert.equal(td.decode(await recovered.read(record)), 'saved conversation survives password updates');
  assert.equal((await recovered.readLog()).at(-1).action, 'vault.password.reset');
  await recovered.cleanup();
  assert.equal((await recovered.readLog()).at(-1).action, 'vault.password.reset', 'cleanup preserves audit history');

  const replacement = await recovered.setupRecovery(RESET);
  assert.notEqual(replacement, recovery);
  await assert.rejects(Vault.resetPassword(store, recovery, NEW), /recovery key is incorrect/);
  const backup = await recovered.backup(), restoredStore = new Store();
  const restored = await Vault.restore(restoredStore, backup, RESET); await restored.lock();
  await Vault.resetPassword(restoredStore, replacement, NEW);
  const restoredReset = await Vault.unlock(restoredStore, NEW);
  assert.deepEqual(await restoredStore.get(record), originalCipher); await restoredReset.lock();
  const oldStore = new Store(), older = await Vault.restore(oldStore, oldBackup, OLD); await older.lock();
  await Vault.resetPassword(oldStore, recovery, NEW);
  const olderReset = await Vault.unlock(oldStore, NEW); await olderReset.lock();
  await recovered.lock();

  for (const operation of ['change', 'recovery']) {
    const legacy = await legacyVault(), saved = await addRecord(legacy.vault), encrypted = (await legacy.store.get(saved)).slice();
    await assert.rejects(legacy.vault.setupRecovery('incorrect'), /current password is incorrect/);
    if (operation === 'change') await legacy.vault.changePassword(OLD, NEW);
    else {
      const secret = await legacy.vault.setupRecovery(OLD);
      await Vault.resetPassword(legacy.store, secret, NEW);
    }
    await legacy.vault.lock();
    const upgraded = await Vault.unlock(legacy.store, NEW);
    assert.equal(upgraded.header.keyScheme, 'wrapped-v1');
    assert.deepEqual(await legacy.store.get(saved), encrypted, 'legacy upgrades preserve encrypted messages');
    assert.equal(td.decode(await upgraded.read(saved)), 'saved conversation survives password updates');
    await upgraded.lock();
  }
  console.log('Password change, recovery reset, key replacement, legacy upgrade, stale-window, failed-write, and backup compatibility checks passed.');
};
