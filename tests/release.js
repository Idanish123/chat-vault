const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const C = require('../app/core.js'), root = path.resolve(__dirname, '..'), output = path.resolve(root, '..', 'DMK-Chat-Vault-PC-portable.zip');
(async () => {
  const data = fs.readFileSync(output), expected = fs.readFileSync(output + '.sha256', 'utf8').split(/\s/)[0];
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), expected);
  for (const [name, bytes] of [['portable', data], ['source', fs.readFileSync(path.join(root, 'app/dmk-chat-vault-source.zip'))]]) {
    const archive = await C.readZip(new File([bytes], name + '.zip')), names = archive.entries.map(entry => entry.name);
    for (const required of ['Start.ps1','Install.ps1','DMK-Chat-Vault.exe','app/index.html','app/processor-worker.js','app/version.json','SECURITY.md','.github/workflows/verify.yml','media/chat-vault-launch.webm','media/chat-vault-preview.png']) assert.ok(names.includes(required), name + ' includes ' + required);
    assert.ok(!names.some(file => /(^|\/)\.env(?:\.|$)/i.test(file) || /(^|\/)vault\.json$/i.test(file) || /\.(bin|dmkvault|log|jsonl|pem|key|p12|pfx)$/i.test(file) || file.includes('Recovery-Key') || file.includes('DO-NOT-PACK') || file.includes('tests/results/')), 'private records, credentials, logs, key downloads and test results are excluded');
    for (const entry of archive.entries) {
      const extracted = await C.extractEntry(archive, entry);
      if (entry.name === 'app/app.js') assert.deepEqual(Buffer.from(extracted), fs.readFileSync(path.join(root, 'app/app.js')));
      if (entry.name === 'DMK-Chat-Vault.exe') assert.equal(Buffer.from(extracted).subarray(0,2).toString(), 'MZ');
    }
  }
  console.log('Release checks passed: ZIP checksums, every entry CRC, native executable, source parity, required assets and private-file exclusion.');
})().catch(error => { console.error(error); process.exitCode = 1; });
