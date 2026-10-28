/* Real Chromium smoke tests using CDP and an isolated disposable browser profile. No external dependencies. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), app = path.join(root, 'app');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch {} await delay(100); } throw Error('Timed out: ' + label); }
function serve() {
  const server = http.createServer((request, response) => {
    let name = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (name.includes('/') || !/^[a-zA-Z0-9_.-]+$/.test(name)) { response.writeHead(404).end(); return; }
    try { const data = fs.readFileSync(path.join(app, name)); response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'text/html'); response.end(data); } catch { response.writeHead(404).end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map(); let next = 0; const errors = [];
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(data); if (value.id) { const request = pending.get(value.id); if (!request) return; pending.delete(value.id); clearTimeout(request.timer); value.error ? request.reject(Error(value.error.message)) : request.resolve(value.result); }
    else if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.text + ': ' + (value.params.exceptionDetails.exception?.description || ''));
  };
  socket.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Browser connection closed.')); } pending.clear(); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  return { send, evaluate, errors, close: () => socket.close() };
}
(async () => {
  const candidates = [path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'), path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'), path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'), process.env.CHROMIUM_PATH].filter(Boolean);
  const binary = candidates.find(file => fs.existsSync(file)); if (!binary) throw Error('Edge/Chrome is required for browser verification. Set CHROMIUM_PATH if necessary.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dmk-ui-')), downloads = path.join(profile, 'downloads'); fs.mkdirSync(downloads);
  const servers = [await serve()]; let child, cdp;
  const url = server => 'http://127.0.0.1:' + server.address().port;
  const password = 'Browser test original password 2026', nextPassword = 'Browser test changed password 2026', resetPassword = 'Browser test reset password 2026';
  try {
    child = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', error => { throw error; });
    const port = await until(() => { const file = path.join(profile, 'DevToolsActivePort'); return fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').split('\n')[0]); }, 'headless browser startup');
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    cdp = await connect(pages.find(page => page.type === 'page').webSocketDebuggerUrl); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    console.log('Browser connected with an isolated test profile.');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    const evaluate = cdp.evaluate, click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const fill = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}`);
    const button = text => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(text)}).click()`);
    const submit = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
    const wait = (expression, label, ms) => until(() => evaluate(expression), label || expression, ms);
    await cdp.send('Page.navigate', { url: url(servers[0]) }); await wait('document.readyState==="complete" && !!window.DMKVault', 'application boot');
    await click('gate-demo'); await wait('document.querySelectorAll(".message").length>0', 'sample before setup');
    console.log('Sample preview passed.');
    assert.equal(await evaluate('document.getElementById("demo-exit").hidden'), false);
    await click('demo-exit'); await click('choose-browser'); await fill('vault-password', password); await fill('vault-confirm', password); await submit('#vault-form');
    await wait('document.getElementById("modal-title").textContent==="Set up password recovery" && document.getElementById("modal").open', 'first-run recovery prompt');
    await fill('security-current-password', password); await submit('.credentials-form');
    await wait('document.getElementById("modal-title").textContent==="Save your recovery key"', 'recovery key generated');
    const recoveryKey = await evaluate('document.querySelector(".recovery-key").textContent');
    await evaluate('document.querySelector(".recovery-confirm input").click()'); await button('I saved it — continue'); await wait('!document.getElementById("modal").open', 'recovery confirmed');
    console.log('First-run recovery passed.');
    const transcript = Array.from({ length: 300 }, (_, index) => `27/10/2026, 12:00 - Person: ${index === 80 || index === 220 ? 'FindThisNeedle ' : ''}Synthetic message ${index}${index === 299 ? ' END OF ARCHIVE' : ''}`).join('\n');
    await evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(transcript)}],'WhatsApp Chat with Browser Test.txt',{type:'text/plain'}));const input=document.getElementById('file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait('document.getElementById("messages").textContent.includes("END OF ARCHIVE")', 'worker import and latest page');
    assert.equal(await evaluate('DMKProcessor.mode'), 'background', 'imports use a real background worker');
    console.log('Worker import passed.');
    const zipBytes = require('./archives.js').storedZip([{name:'_chat.txt',text:'ZIP worker extraction test'}]);
    const extracted = await evaluate(`(async()=>{const file=new File([Uint8Array.from(${JSON.stringify([...zipBytes])})],'worker.zip');const archive=await DMKProcessor.run('archiveRead',{file});const bytes=await DMKProcessor.run('archiveExtract',{archive,entry:archive.entries[0],maxSize:1024});return new TextDecoder().decode(bytes)})()`);
    assert.equal(extracted,'ZIP worker extraction test');
    await click('search-toggle'); await fill('message-search', 'FindThisNeedle'); await evaluate('document.getElementById("message-search").dispatchEvent(new Event("input",{bubbles:true}))');
    await wait('document.getElementById("search-result-count").textContent==="2 of 2"', 'newest match selected');
    await click('search-next'); await wait('document.getElementById("search-result-count").textContent==="1 of 2"', 'search wraps');
    assert.ok(await evaluate('document.querySelectorAll(".message").length>50'), 'surrounding messages stay visible');
    await click('scroll-bottom-button'); await wait('document.getElementById("message-search").value==="" && document.getElementById("messages").textContent.includes("END OF ARCHIVE")', 'latest clears filters and reaches the real ending');
    const output = path.join(root, 'tests', 'results'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'conversation-desktop.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await click('storage-button'); await button('Change password'); await fill('security-current-password', password); await fill('security-new-password', nextPassword); await fill('security-confirm-password', nextPassword); await submit('.credentials-form');
    await wait('!document.getElementById("modal").open && document.getElementById("toast").textContent.includes("Password changed")', 'password changed');
    await click('clear-button'); await wait('!document.getElementById("vault-gate").hidden && document.getElementById("busy-overlay").hidden', 'library fully locked'); await fill('vault-password', password); await submit('#vault-form'); await wait('!document.getElementById("vault-error").hidden', 'old password rejected');
    await click('forgot-password-button'); await fill('reset-recovery-key', recoveryKey); await fill('reset-new-password', resetPassword); await fill('reset-confirm-password', resetPassword); await submit('.credentials-form');
    await wait('!document.getElementById("modal").open && document.getElementById("toast").textContent.includes("Password reset")', 'forgot-password reset');
    await fill('vault-password', resetPassword); await submit('#vault-form'); await wait('document.getElementById("messages").textContent.includes("END OF ARCHIVE")', 'history survives reset');
    await click('storage-button'); await button('Download encrypted backup');
    const backupPath = await until(() => { const name = fs.readdirSync(downloads).find(name => name.endsWith('.dmkvault')); return name && path.join(downloads, name); }, 'validated backup download');
    const events = await evaluate(`(async()=>{const store=await DMKVault.BrowserStore.open(),v=await DMKVault.Vault.unlock(store,${JSON.stringify(resetPassword)});const events=await v.readLog();await v.lock();return events})()`);
    const logText = JSON.stringify(events); for (const secret of [password, nextPassword, resetPassword, recoveryKey, 'FindThisNeedle']) assert.ok(!logText.includes(secret), 'logs contain no secrets or message query');
    assert.ok(events.some(event => event.action === 'vault.password.reset'));
    servers.push(await serve()); await cdp.send('Page.navigate', { url: url(servers[1]) }); await wait('document.readyState==="complete" && !!window.DMKVault', 'clean restore origin'); await click('choose-browser');
    const doc = await cdp.send('DOM.getDocument'), input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#restore-backup-input' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [backupPath] }); await wait('!document.getElementById("restore-key-options").hidden', 'backup restore form');
    await click('restore-with-key'); await fill('restore-recovery-key', recoveryKey); await fill('vault-password', password); await fill('vault-confirm', password); await submit('#vault-form');
    await wait('document.getElementById("messages").textContent.includes("END OF ARCHIVE")', 'restore with recovery key');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'no horizontal page overflow on mobile');
    fs.writeFileSync(path.join(output, 'conversation-mobile.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate('window.originalNow=Date.now; Date.now=()=>window.originalNow()+11*60*1000');
    await wait('!document.getElementById("vault-gate").hidden', 'automatic idle lock', 25000); await evaluate('Date.now=window.originalNow');
    await cdp.send('Page.navigate', { url: require('node:url').pathToFileURL(path.join(app, 'offline.html')).href });
    await wait('document.readyState==="complete" && !!window.DMKProcessor', 'single-file offline viewer boot');
    const offline = await evaluate(`(async()=>{const result=await DMKProcessor.run('parse',{text:'27/10/2026, 12:00 - Person: Offline parsing',options:{dateOrder:'DMY'}});return {count:result.messages.length,mode:DMKProcessor.mode}})()`);
    assert.deepEqual(offline,{count:1,mode:'background'},'standalone file uses its bundled background worker');
    assert.deepEqual(cdp.errors, [], 'no uncaught browser runtime exceptions');
    console.log('Real Edge/Chrome checks passed: sample, first-run recovery, worker import/extraction, contextual search, true latest, password change/reset, private logs, recovery-key restore, mobile layout, idle lock and standalone offline worker.');
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.close(); }
    if (child && child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]); if (child.exitCode === null) child.kill(); }
    for (const server of servers) server.close();
    if (path.resolve(profile).startsWith(path.resolve(os.tmpdir(), 'dmk-ui-'))) { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch {} }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
