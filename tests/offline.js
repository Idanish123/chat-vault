const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const app = path.join(__dirname, '..', 'app'), html = fs.readFileSync(path.join(app, 'offline.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const sources = ['core.js', 'vendor-rar.js', 'archives.js', 'vault.js', 'library.js', 'bootstrap.js', 'processor.js', 'app.js'];
assert.equal(scripts.length, sources.length, 'offline build has every bundled script');
for (let i = 0; i < sources.length; i++) {
  const expected = fs.readFileSync(path.join(app, sources[i]), 'utf8').replace(/\r\n?/g, '\n');
  assert.equal(scripts[i][1], expected, `offline ${sources[i]} matches current source exactly`);
  const hash = crypto.createHash('sha256').update(scripts[i][1].replace(/\r\n?/g, '\n')).digest('base64');
  assert.ok(html.includes(`'sha256-${hash}'`), 'inline script has the correct CSP hash');
  assert.ok(scripts[i].index > html.indexOf('id="modal"'), 'DOM exists before inline scripts run');
  new Function(scripts[i][1]);
}
for (const id of ['forgot-password-button', 'vault-form', 'scroll-bottom-button', 'search-next']) assert.ok(html.includes(`id="${id}"`));
const worker = JSON.parse(html.match(/<script type="application\/json" id="processor-source">([\s\S]*?)<\/script>/)[1]);
new Function(worker);
assert.ok(html.includes("worker-src blob:"), 'offline background worker is allowed by CSP');
const source = fs.readFileSync(path.join(app, 'app.js'), 'utf8');
assert.ok(!/\u00e2\u20ac[\u2122\u0153\u009d]|\u00f0\u0178/.test(source), 'UI text has no known mojibake');
console.log('Offline source parity, script order, syntax, password controls, and CSP hashes passed.');
