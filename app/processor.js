/* One worker, bounded pending work, and an explicit compatibility fallback. */
(function (root) {
  'use strict';
  let worker, nextId = 0, unavailable = false; const pending = new Map();
  function notify() { root.dispatchEvent?.(new Event('dmk-processing-status')); }
  function stop(message = 'Import cancelled.') {
    worker?.terminate(); worker = null;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new DOMException(message, 'AbortError')); }
    pending.clear(); notify();
  }
  function start() {
    if (worker || unavailable) return;
    try {
      const inline = root.document?.getElementById('processor-source');
      let url = 'processor-worker.js';
      if (inline) url = URL.createObjectURL(new Blob([JSON.parse(inline.textContent)], { type: 'text/javascript' }));
      try { worker = new Worker(url); } finally { if (inline) URL.revokeObjectURL(url); }
      worker.onmessage = ({ data }) => {
        const item = pending.get(data.id); if (!item) return;
        pending.delete(data.id); clearTimeout(item.timer);
        if (data.error) { const error = Error(data.error.message); error.name = data.error.name; item.reject(error); } else item.resolve(data.result);
      };
      worker.onerror = () => { unavailable = true; stop('Background processing could not start. Retry the import using compatibility processing.'); };
    } catch { unavailable = true; }
    notify();
  }
  async function run(operation, args) {
    start();
    if (worker) return new Promise((resolve, reject) => {
      if (pending.size >= 8) { reject(Error('Too many processing tasks. Wait for the current import.')); return; }
      const id = ++nextId, timer = setTimeout(() => stop('Processing timed out. Try a smaller export.'), 120000);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, operation, args }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    if (operation === 'parse') return root.ChatCore.parseChat(args.text, args.options);
    if (operation === 'archiveRead') return root.DMKArchives.read(args.file);
    if (operation === 'archiveExtract') return root.DMKArchives.extract(args.archive, args.entry, args.maxSize);
    if (operation === 'hash') return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await args.file.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('');
    throw Error('Unsupported processing operation.');
  }
  root.DMKProcessor = { run, cancel: stop, get mode() { return worker ? 'background' : unavailable ? 'compatibility' : 'ready'; } };
})(typeof window === 'undefined' ? globalThis : window);
