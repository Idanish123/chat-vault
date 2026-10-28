/* Heavy export work runs in an isolated worker. No chat data leaves this device. */
if (typeof importScripts === 'function' && !globalThis.ChatCore) importScripts('core.js', 'vendor-rar.js', 'archives.js');
self.onmessage = async ({ data }) => {
  try {
    const { operation, args } = data; let result;
    if (operation === 'parse') result = ChatCore.parseChat(args.text, args.options);
    else if (operation === 'hash') result = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await args.file.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('');
    else if (operation === 'archiveRead') result = await DMKArchives.read(args.file);
    else if (operation === 'archiveExtract') result = await DMKArchives.extract(args.archive, args.entry, args.maxSize);
    else throw Error('Unsupported processing operation.');
    self.postMessage({ id: data.id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) { self.postMessage({ id: data.id, error: { message: error.message, name: error.name } }); }
};
