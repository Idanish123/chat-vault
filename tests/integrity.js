const assert = require('node:assert/strict');
const C = require('../app/core.js'), { Vault, sanitizeEvent } = require('../app/vault.js'), { Library, mergeMessages } = require('../app/library.js');
require('../app/archives.js');
const password = 'Synthetic integrity test password';
class Store {
  constructor() { this.data = new Map(); this.failAt = null; }
  async get(name) { return this.data.get(name); }
  async put(name, value) { if (name === this.failAt) throw Error('Simulated write failure'); this.data.set(name, value.slice()); }
  async list() { return [...this.data.keys()]; }
  async remove(name) { this.data.delete(name); }
}
module.exports = async function integrityTests() {
  const safe = sanitizeEvent({ at: new Date().toISOString(), action: 'test.privacy', details: { count: 1, password: 'PRIVATE', query: 'PRIVATE', control: 'known-control', category: { password: 'PRIVATE' } } });
  assert.deepEqual(safe.details, { count: 1, control: 'known-control' }); assert.throws(() => sanitizeEvent({ at: 'bad', action: 'test' }));
  const first = C.parseChat('27/10/2026, 12:00 - Person: IMG-one.jpg (file attached)', { dateOrder: 'DMY' });
  const second = C.parseChat('27/10/2026, 12:00 - Person: IMG-two.jpg (file attached)', { dateOrder: 'DMY' });
  assert.equal(mergeMessages(first.messages, second.messages).messages.length, 2, 'different attachments are retained');
  assert.equal(mergeMessages(first.messages, first.messages).messages.length, 1, 'the same attachment is matched');
  const changedContent = structuredClone(first.messages); first.messages[0].attachment.crc = 1; changedContent[0].attachment.crc = 2;
  assert.equal(mergeMessages(first.messages, changedContent).messages.length, 2, 'same filename with distinct known content is not collapsed');
  const repeated = C.parseChat('27/10/2026, 12:00 - Person: Same\n27/10/2026, 12:00 - Person: Same', { dateOrder: 'DMY' });
  assert.equal(mergeMessages(repeated.messages, repeated.messages.slice(0, 1)).messages.length, 2, 'identical occurrences are preserved');
  assert.deepEqual(C.matchRanges('Cafe\u0301 and CAFÉ', 'café'), [[0, 5], [10, 14]]);
  assert.deepEqual(C.matchRanges('🙂 café', 'café'), [[3, 7]]);
  assert.deepEqual(C.matchRanges('ΟΣ', 'ος'), [[0, 2]], 'context-dependent lowercasing preserves highlighting');
  const localized = C.parseChat('27/10/2026, 12:00 - Person: IMG-test.jpg (fichier joint)\nCaption', { dateOrder: 'DMY', files: C.mediaIndex([{name:'IMG-test.jpg',size:12,crc:1}]) });
  assert.equal(localized.messages[0].attachment.name, 'IMG-test.jpg'); assert.equal(localized.messages[0].attachment.caption, 'Caption');
  assert.equal(C.parseChat('27/10/2026, 12:00 - Person: This image omitted some detail', { dateOrder: 'DMY' }).messages[0].attachment, null, 'ordinary prose is never mistaken for an omitted-media marker');
  assert.equal(C.parseChat('۲۷/۱۰/۲۰۲۶, ۱۲:۰۰ - علی: سلام', { dateOrder: 'DMY' }).messages[0].sender, 'علی');
  assert.throws(() => C.decodeText(Uint8Array.of(0xff)), /encoded data/);

  const store = new Store(), vault = await Vault.create(store, password), library = new Library(vault);
  const file = new File(['27/10/2026, 12:00 - Person: Original'], 'WhatsApp Chat with Test.txt');
  const [item] = await library.prepare(file, 'DMY');
  item.parsed.messages[0].text = 'A preserved multiline body\n27/10/2026, 12:01 - Someone: quoted transcript line\nسلام 🙂';
  const result = await library.import(item), meta = vault.index.chats[0];
  const opened = await library.open(result.id);
  assert.equal(opened.messages.length, 1); assert.equal(opened.messages[0].text, item.parsed.messages[0].text, 'saved messages are never reparsed as transcript headers');
  assert.equal((await library.import(item, result.id)).duplicate, true);
  const missingName = meta.dataFile, original = await store.get(missingName);
  await store.remove(missingName); await assert.rejects(vault.backup(), /required library record is missing/); await store.put(missingName, original);
  const corrupted = original.slice(); corrupted[corrupted.length - 1] ^= 1; await store.put(missingName, corrupted); await assert.rejects(vault.backup(), /damaged/); await store.put(missingName, original);
  const recovery = await vault.setupRecovery(password), backup = await vault.backup();
  await assert.rejects(Vault.restore(new Store(), backup, password, { recoveryKey: '' }), /Wrong backup password or recovery key/);
  const damaged = new Uint8Array(await backup.arrayBuffer()); damaged[damaged.length - 1] ^= 1;
  const destination = new Store(); await assert.rejects(Vault.restore(destination, new Blob([damaged]), password));
  assert.equal((await destination.list()).length, 0, 'all backup records are authenticated before writing');
  destination.failAt = missingName; await assert.rejects(Vault.restore(destination, backup, password), /write failure/);
  assert.equal((await destination.list()).length, 0, 'failed restore rolls back its partial records'); destination.failAt = null;
  const restored = await Vault.restore(destination, backup, 'New restore password 2026', { recoveryKey: recovery });
  assert.equal((await new Library(restored).open(result.id)).messages[0].text, item.parsed.messages[0].text);
  await restored.lock(); await assert.rejects(Vault.unlock(destination, password), /Wrong password/);
  const reopened = await Vault.unlock(destination, 'New restore password 2026'); await reopened.lock();
  await assert.rejects(Vault.restore(destination, backup, password), /empty/);
  const stale = await Vault.unlock(store, password); await vault.change(i => { i.settings.theme = 'dark'; });
  await assert.rejects(stale.backup(), /another window/); await assert.rejects(stale.cleanup(), /another window/); await stale.lock();
  await vault.appendLog({ at: new Date().toISOString(), action: 'test.log', details: { count: 1 } });
  const logBytes = (await store.get('activity.bin')).slice(); logBytes[logBytes.length - 1] ^= 1; await store.put('activity.bin', logBytes);
  await assert.rejects(vault.appendLog({ at: new Date().toISOString(), action: 'test.next', details: {} }));
  assert.deepEqual(await store.get('activity.bin'), logBytes, 'damaged audit history is not overwritten');
  await vault.lock();
  console.log('Integrity regressions passed: attachment identity, Unicode, structured persistence, fail-closed backups, atomic restore, recovery-key restore, and stale-window protection.');
};
