(function (root) {
  'use strict';
  let queue = Promise.resolve();
  const serial = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  async function rarExtractor(file, fn) {
    return serial(async () => { if (!root.DMKUnrar) throw Error('The local RAR reader is missing. Download the complete PC edition.'); const extractor = await root.DMKUnrar.create(await file.arrayBuffer()); try { return await fn(extractor); } finally { extractor.unrar.extractor = null; } });
  }
  async function read(file) {
    if (!/\.rar$/i.test(file.name)) return { ...await root.ChatCore.readZip(file), kind: 'zip' };
    if (file.size > 100 * 1024 ** 2) throw Error('RAR files must be 100 MB or smaller. ZIP supports 250 MB.');
    return rarExtractor(file, extractor => {
      const list = extractor.getFileList(), entries = [], names = new Set(); let total = 0, count = 0, error = null;
      if (list.arcHeader.flags.volume || list.arcHeader.flags.headerEncrypted) error = Error('Split and encrypted RAR archives are not supported.');
      for (const h of list.fileHeaders) {
        count++; total += h.unpSize;
        const name = h.name.replace(/\\/g, '/');
        if (count > 25000 || h.unpSize > root.ChatCore.LIMITS.entry || total > 250 * 1024 ** 2 || (h.unpSize > 1024 ** 2 && h.unpSize / Math.max(h.packSize, 1) > 500)) error = Error('RAR expansion exceeds the safety limits (100 MB per file, 250 MB expanded).');
        if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\0') || name.split('/').includes('..') || h.flags.encrypted) error = Error('RAR contains an unsafe path or encrypted entry.');
        if (h.flags.directory || name.startsWith('__MACOSX/') || root.ChatCore.basename(name).startsWith('.')) continue;
        const normalized = root.ChatCore.normalize(name); if (names.has(normalized)) error = Error('RAR contains duplicate filenames.'); names.add(normalized);
        if (!error) entries.push({ name, rarName: h.name, size: h.unpSize, compressed: h.packSize, crc: h.crc });
      }
      if (error) throw error;
      return { kind: 'rar', file, entries };
    });
  }
  async function extract(archive, entry, maxSize = root.ChatCore.LIMITS.entry) {
    if (archive.kind !== 'rar') return root.ChatCore.extractEntry(archive, entry, maxSize);
    if (entry.size > maxSize) throw Error('This file exceeds the permitted extraction size.');
    return rarExtractor(archive.file, extractor => {
      const originalWrite = extractor.write.bind(extractor), written = new Map();
      extractor.write = (fd, ptr, size) => { const n = (written.get(fd) || 0) + size; if (n > maxSize || n > entry.size) throw Error('RAR extraction exceeded its declared size.'); written.set(fd, n); return originalWrite(fd, ptr, size); };
      const extraction = extractor.extract({ files: [entry.rarName] }); let result;
      for (const f of extraction.files) if (f.fileHeader.name === entry.rarName) result = f.extraction;
      if (!result || result.length !== entry.size || root.ChatCore.crc32(result) !== (entry.crc >>> 0)) throw Error('RAR integrity verification failed.'); return result;
    });
  }
  root.DMKArchives = { read, extract };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DMKArchives;
})(typeof window === 'undefined' ? globalThis : window);
