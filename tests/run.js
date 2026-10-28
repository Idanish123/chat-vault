const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
global.crypto = webcrypto;
global.btoa = value => Buffer.from(value, 'binary').toString('base64');
global.atob = value => Buffer.from(value, 'base64').toString('binary');
const ChatCore = require('../app/core.js');
const { mergeMessages } = require('../app/library.js');
const { Vault } = require('../app/vault.js');
const fs = require('node:fs');

const transcript = [
  '21/10/2026, 09:10 - Ayesha: Hello there',
  '21/10/2026, 09:12 - You: Hello there',
  '21/10/2026, 09:12 - You: Hello there',
  '21/10/2026, 09:14 - Messages and calls are end-to-end encrypted.'
].join('\n');
const parsed = ChatCore.parseChat(transcript, { dateOrder: 'DMY' });
assert.equal(parsed.messages.length, 4);
assert.deepEqual(parsed.participants, ['Ayesha', 'You']);
assert.equal(parsed.messages[3].system, true);
assert.equal(ChatCore.parseDate, undefined);

const merged = mergeMessages(parsed.messages, parsed.messages.slice(0, 3));
assert.equal(merged.messages.length, 4, 'shorter imports keep older messages');
assert.equal(merged.matched, 3);
assert.equal(merged.retained, 1);

assert.equal(ChatCore.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
assert.throws(() => ChatCore.parseChat('this is not a WhatsApp export'), /No WhatsApp messages found/);

class MemoryStore {
  constructor() { this.data = new Map(); this.kind = 'memory'; }
  async get(key) { return this.data.get(key); }
  async put(key, value) { this.data.set(key, value instanceof Uint8Array ? value : new Uint8Array(value)); }
  async remove(key) { this.data.delete(key); }
  async list() { return [...this.data.keys()]; }
}
(async () => {
  const store = new MemoryStore(), vault = await Vault.create(store, 'local test password 2026');
  await vault.appendLog({ at: '2026-10-22T00:00:00.000Z', action: 'test.event', details: { count: 1 } });
  assert.equal((await vault.readLog())[0].action, 'test.event');
  const backup = await vault.backup();
  const raw = new TextDecoder().decode(await backup.arrayBuffer());
  assert.ok(!raw.includes('test.event'), 'activity records remain encrypted in backups');
  await vault.lock();
  const restoredStore = new MemoryStore(), restored = await Vault.restore(restoredStore, backup, 'local test password 2026');
  assert.equal((await restored.readLog())[0].action, 'test.event');
  await restored.lock();
  console.log('Encrypted activity log and backup/restore checks passed.');
  await require('./passwords.js')();
  await require('./integrity.js')();
  await require('./archives.js')();
})().catch(error => { console.error(error); process.exitCode = 1; });

for (const file of ['index.html', 'offline.html', 'styles.css', 'app.js', 'vault.js']) assert.ok(fs.existsSync(require('node:path').join(__dirname, '..', 'app', file)));
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'app', 'index.html'), 'utf8');
for (const id of ['scroll-bottom-button', 'search-previous', 'search-next', 'search-result-count']) assert.ok(html.includes(`id="${id}"`), `${id} exists in the UI`);
console.log('All parser, merge, CRC, invalid-input, and UI-source checks passed.');
require('./offline.js');
