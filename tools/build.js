const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'app');

function buildOffline() {
  const htmlPath = path.join(app, 'offline.html');
  let html = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(app, 'styles.css'), 'utf8');
  html = html.replace(/<link rel="stylesheet" href="styles\.css">/, () => `<style>${css}</style>`);
  const scripts = ['core.js', 'vendor-rar.js', 'archives.js', 'vault.js', 'library.js', 'bootstrap.js', 'processor.js', 'app.js'];
  const hashes = [];
  const inlineScripts = [];
  for (const filename of scripts) {
    // HTML parsers normalize CRLF before CSP validation, so hash the normalized inline text.
    const source = fs.readFileSync(path.join(app, filename), 'utf8').replace(/\r\n?/g, '\n');
    hashes.push(`'sha256-${crypto.createHash('sha256').update(source).digest('base64')}'`);
    const tag = `<script src="${filename}" defer></script>`;
    html = html.replace(tag, '');
    inlineScripts.push(`<script>${source}</script>`);
  }
  // The application reads DOM elements immediately; inline scripts run after the body is built.
  const workerSource = ['core.js', 'vendor-rar.js', 'archives.js', 'processor-worker.js'].map(name => fs.readFileSync(path.join(app, name), 'utf8').replace(/\r\n?/g, '\n')).join('\n');
  const workerData = JSON.stringify(workerSource).replace(/</g, '\\u003c');
  html = html.replace('</body>', () => `<script type="application/json" id="processor-source">${workerData}</script>\n</body>`);
  html = html.replace('</body>', () => inlineScripts.join('\n') + '\n</body>');
  html = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${hashes.join(' ')} 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src blob:; frame-src 'none'">`);
  fs.writeFileSync(htmlPath, html, 'utf8');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipDirectory(sourceDir, outputPath) {
  const files = [];
  const releaseFolders = new Set(['app', 'licenses', 'tests', 'tools', '.github', 'media']);
  const releaseFiles = new Set(['README.md', 'READ-ME-FIRST.txt', 'CHANGELOG.md', 'SECURITY.md', 'package.json', 'Start.cmd', 'Start.ps1', 'Install.cmd', 'Install.ps1', 'DMK-Chat-Vault.exe', 'Create-desktop-shortcut.cmd', 'Create-desktop-shortcut.ps1', '.editorconfig', '.gitignore']);
  const runtimeAssets = new Set(['app.js','archives.js','bootstrap.js','core.js','library.js','vault.js','processor.js','processor-worker.js','vendor-rar.js','index.html','styles.css','offline.html','version.json','dmk-chat-vault-source.zip']);
  const licenseFiles = new Set(['node-unrar-js-LICENSE.md','rarfile-fixtures-LICENSE.txt','UNRAR-LICENSE.txt']);
  const mediaFiles = new Set(['chat-vault-launch.webm', 'chat-vault-preview.png']);
  const developmentFiles = new Set(['tests/archives.js', 'tests/browser.js', 'tests/integrity.js', 'tests/launcher.js', 'tests/offline.js', 'tests/passwords.js', 'tests/release.js', 'tests/run.js', 'tools/Launcher.cs', 'tools/build.js', '.github/workflows/verify.yml']);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (path.resolve(full) === path.resolve(outputPath)) continue;
      if (dir === sourceDir && !(entry.isDirectory() ? releaseFolders : releaseFiles).has(entry.name)) continue;
      if (entry.name === 'node_modules' || entry.name === 'results') continue;
      if (entry.isDirectory()) walk(full);
      else {
        const relative = path.relative(sourceDir, full).split(path.sep);
        if (relative[0] === 'app' && (relative.length !== 2 || !runtimeAssets.has(entry.name))) continue;
        if (relative[0] === 'licenses' && (relative.length !== 2 || !licenseFiles.has(entry.name))) continue;
        if (relative[0] === 'media' && (relative.length !== 2 || !mediaFiles.has(entry.name))) continue;
        if (['tests', 'tools', '.github'].includes(relative[0]) && !developmentFiles.has(relative.join('/'))) continue;
        files.push(full);
      }
    }
  }
  walk(sourceDir);
  const locals = [], centrals = [];
  let offset = 0;
  for (const full of files) {
    const name = path.relative(sourceDir, full).split(path.sep).join('/');
    const nameBytes = Buffer.from(name, 'utf8'), raw = fs.readFileSync(full), compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw), local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42); nameBytes.copy(central, 46);
    centrals.push(central); offset += local.length + compressed.length;
  }
  const centralSize = centrals.reduce((total, chunk) => total + chunk.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outputPath, Buffer.concat([...locals, ...centrals, end]));
}

function writeVersion() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const hash = crypto.createHash('sha256');
  for (const file of [...fs.readdirSync(app).filter(name => /\.(js|css)$/.test(name)), 'index.html'].sort()) hash.update(fs.readFileSync(path.join(app, file)));
  hash.update(fs.readFileSync(path.join(root, 'Start.ps1')));
  fs.writeFileSync(path.join(app, 'version.json'), JSON.stringify({ version, build: hash.digest('hex').slice(0, 24) }, null, 2) + '\n');
}
function compileLauncher() {
  if (process.platform !== 'win32') throw Error('Build the Windows executable on Windows using the included .NET Framework C# compiler.');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/reference:System.Windows.Forms.dll', '/out:' + path.join(root, 'DMK-Chat-Vault.exe'), path.join(root, 'tools', 'Launcher.cs')], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || Error(result.stdout + result.stderr);
}
writeVersion(); buildOffline();
if (process.argv.includes('--package')) {
  compileLauncher();
  // Refresh the downloadable source bundle, excluding the archive being generated.
  zipDirectory(root, path.join(app, 'dmk-chat-vault-source.zip'));
  const output = path.resolve(root, '..', 'DMK-Chat-Vault-PC-portable.zip');
  zipDirectory(root, output);
  fs.writeFileSync(output + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex') + '  ' + path.basename(output) + '\n');
  console.log(`Portable package created: ${output}`);
} else console.log('Offline viewer rebuilt from index.html, styles.css and JavaScript sources.');
