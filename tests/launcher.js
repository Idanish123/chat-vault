const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function runScript(file, args) {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, file), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve({ code, output })); }); return { child, done };
}
async function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method || 'GET', headers: options.headers || {}, agent: false }, response => {
      const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => {
        const data = Buffer.concat(chunks); resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers: { get: name => response.headers[name.toLowerCase()] }, text: async () => data.toString(), json: async () => JSON.parse(data.toString()), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) });
      }); response.on('error', reject);
    });
    request.setTimeout(6000, () => request.destroy(Error('Local launcher request timed out.'))); request.on('error', reject); request.end();
  });
}
module.exports = async function launcherTests() {
  if (process.platform !== 'win32') throw Error('Launcher verification requires Windows.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmk-launcher-')), logs = path.join(temp, 'logs'); fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'launcher.jsonl'), 'x'.repeat(1024 * 1024 + 1));
  const port = await freePort(), address = 'http://127.0.0.1:' + port;
  const server = runScript('Start.ps1', ['-NoBrowser', '-Quiet', '-Port', String(port), '-LogDirectory', logs]);
  let token;
  try {
    const until = Date.now() + 15000; let health;
    while (Date.now() < until) { try { const response = await get(address + '/__dmk_health'); if (response.ok) { health = await response.json(); break; } } catch {} if (server.child.exitCode !== null) break; await delay(150); }
    assert.ok(health, 'launcher starts and exposes health metadata');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'app/version.json'), 'utf8')); assert.equal(health.version, version.version); assert.equal(health.build, version.build);
    const page = await get(address); assert.equal(page.status, 200); assert.equal(page.headers.get('x-frame-options'), 'DENY'); assert.ok(page.headers.get('content-security-policy').includes("worker-src 'self' blob:"));
    const head = await get(address + '/index.html', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const route of ['/vault.json','/activity.bin','/../README.md','/not-allowed.exe']) assert.equal((await get(address + route)).status, 404, 'private/unlisted files are not served');
    assert.equal((await get(address + '/__dmk_shutdown', { method: 'POST' })).status, 403);
    assert.equal((await get(address + '/index.html', { method: 'POST' })).status, 405);
    assert.equal((await get(address + '/index.html', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const hostileHost = await new Promise((resolve, reject) => { http.get(address, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); }); assert.equal(hostileHost, 403);
    const source = await (await get(address + '/bootstrap.js')).text(); const desktop = JSON.parse(source.slice('window.DMKDesktop='.length, -1)); token = desktop.token; assert.equal(token.length, 44);
    assert.equal((await get(address + '/__dmk_heartbeat', { method: 'POST' })).status, 403);
    const windowId = crypto.randomUUID(); assert.equal((await get(address + '/__dmk_heartbeat', { method: 'POST', headers: { 'X-DMK-Token': token, 'X-DMK-Window': windowId } })).status, 200);
    const sameCopy = runScript('Start.ps1', ['-NoBrowser', '-Quiet', '-Port', String(port), '-LogDirectory', logs]); assert.equal((await sameCopy.done).code, 0, 'the same version and folder can reuse the running launcher');
    await get(address + '/__dmk_shutdown', { method: 'POST', headers: { 'X-DMK-Token': token } }); assert.equal((await server.done).code, 0);
    const log = fs.readFileSync(path.join(logs, 'launcher.jsonl'), 'utf8'); assert.ok(log.includes('launcher.stop')); assert.ok(!log.includes(token)); assert.ok(fs.existsSync(path.join(logs, 'launcher.jsonl.1')), 'launcher logs rotate');
    const fakePort = await freePort(), fake = http.createServer((_request, response) => { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({ identity: health.identity, root: 'different-root' })); });
    await new Promise(resolve => fake.listen(fakePort, '127.0.0.1', resolve));
    try { const mismatch = runScript('Start.ps1', ['-NoBrowser', '-Quiet', '-Port', String(fakePort), '-LogDirectory', logs]); assert.notEqual((await mismatch.done).code, 0, 'a different copy/version is never silently reused'); } finally { fake.close(); }
    if (fs.existsSync(path.join(root, 'DMK-Chat-Vault.exe'))) {
      const destination = path.join(temp, 'installed application');
      const install = runScript('Install.ps1', ['-Destination', destination, '-NoShortcut']); const result = await install.done; assert.equal(result.code, 0, result.output);
      for (const name of ['DMK-Chat-Vault.exe', 'Start.ps1', 'app/index.html', 'app/version.json', 'licenses/UNRAR-LICENSE.txt', 'media/chat-vault-launch.webm', 'media/chat-vault-preview.png']) assert.ok(fs.existsSync(path.join(destination, name)), 'installer includes ' + name);
    }
    console.log('Windows launcher checks passed: startup, version/root identity, HTTP/CSP protections, private-file isolation, authenticated shutdown, log rotation and installer layout.');
  } finally {
    if (server.child.exitCode === null) { try { if (token) await get(address + '/__dmk_shutdown', { method: 'POST', headers: { 'X-DMK-Token': token } }); } catch {} await Promise.race([server.done, delay(1500)]); if (server.child.exitCode === null) server.child.kill(); }
    if (path.resolve(temp).startsWith(path.resolve(os.tmpdir(), 'dmk-launcher-'))) { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch {} }
  }
};
if (require.main === module) module.exports().catch(error => { console.error(error); process.exitCode = 1; });
