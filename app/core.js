/* DMK Chat Vault — dependency-free WhatsApp export parsing and bounded ZIP reading. */
(function (root) {
  'use strict';
  const LIMITS = Object.freeze({ archive: 250 * 1024 ** 2, text: 20 * 1024 ** 2, entry: 100 * 1024 ** 2, total: 750 * 1024 ** 2, entries: 25000, messages: 200000, ratio: 500 });
  const clean = s => s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  const digits = s => s.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, c => String(c.charCodeAt(0) - (c.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660)));
  const basename = s => s.replace(/\\/g, '/').split('/').pop();
  const normalize = s => clean(s).normalize('NFC').toLowerCase();
  function parseHeader(line) {
    const original = clean(line), s = digits(original).replace(/[\u00a0\u202f]/g, ' ');
    const m = s.match(/^\[?(\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4})[,]?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([ap]\.?\s*m\.?)?\]?\s*(?:[-–]\s*)?(.*)$/i);
    return m ? { date: m[1], clock: m[2], ampm: m[3] || '', body: original.slice(original.length - m[4].length) } : null;
  }
  function decideOrder(headers, preferred) {
    if (preferred === 'DMY' || preferred === 'MDY') return { order: preferred, ambiguous: false };
    let dmy = false, mdy = false;
    for (const h of headers) {
      const [a, b] = h.date.split(/[/.\-]/).map(Number);
      if (String(h.date.split(/[/.\-]/)[0]).length === 4) continue;
      if (a > 12) dmy = true;
      if (b > 12) mdy = true;
    }
    if (dmy && mdy) throw Error('This transcript mixes date formats. Import separate original WhatsApp exports.');
    return { order: mdy ? 'MDY' : 'DMY', ambiguous: !dmy && !mdy && headers.some(h => h.date.split(/[/.\-]/)[0].length !== 4) };
  }
  function parseDate(h, order) {
    const ds = h.date.split(/[/.\-]/), ns = ds.map(Number);
    let year, month, day;
    if (ds[0].length === 4) [year, month, day] = ns;
    else { year = ns[2]; [day, month] = order === 'DMY' ? ns : [ns[1], ns[0]]; }
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    let [hour, minute, second = 0] = h.clock.split(':').map(Number);
    const ap = h.ampm.replace(/[.\s]/g, '').toLowerCase();
    if (ap) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (ap === 'pm' ? 12 : 0); }
    if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    // Export timestamps have no timezone. Keep wall-clock values rather than inventing an offset.
    const d = new Date(year, month - 1, day, hour, minute, second);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return { timestamp: d.getTime(), day: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
  }
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf' };
  function fileType(name) {
    const ext = basename(name).split('.').pop().toLowerCase(), mime = mimeMap[ext] || 'application/octet-stream';
    const sticker = mime.startsWith('image/') && /(?:^STK[-_]|(?:^|[-_ .])STICKER(?:[-_ .]|$))/i.test(basename(name));
    return { mime, kind: sticker ? 'sticker' : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document', ext };
  }
  const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  function emojiOnlyCount(text) {
    // Count grapheme clusters, not code points: a family, skin tone, or flag is one emoji.
    // This only controls presentation. Never replace the original Unicode sequence.
    if (!graphemes || !text.trim() || text.length > 2048) return 0;
    let count = 0;
    for (const { segment } of graphemes.segment(clean(text).trim())) {
      if (/^\s+$/u.test(segment)) continue;
      const flag = /^\p{Regional_Indicator}{2}$/u.test(segment);
      const keycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(segment);
      const pictograph = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(segment)
        && !/\uFE0E/u.test(segment) && !/^[©®™]$/u.test(segment) && !/^\p{Emoji_Modifier}$/u.test(segment) && !/^\p{Regional_Indicator}$/u.test(segment)
        && /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\u200D|\uFE0F|[\u{E0020}-\u{E007F}])+$/u.test(segment);
      if (!(flag || keycap || pictograph) || ++count > 3) return 0;
    }
    return count;
  }
  function attachment(text, files) {
    const t = clean(text);
    const patterns = [/<attached:\s*([^>]+)>/i, /^(.+?)\s*\((?:file attached|attached file|sticker attached|sticker file attached)\)/im];
    let name = '', caption = text;
    for (const p of patterns) { const m = t.match(p); if (m) { name = m[1].trim(); caption = t.replace(m[0], '').trim(); break; } }
    if (!name && files) {
      const first = t.split('\n')[0].trim(), candidate = first.replace(/\s*\([^()]{1,80}\)\s*$/, '').replace(/^<[^:>]{1,30}:\s*([^>]+)>$/, '$1').trim();
      if (files.has(normalize(first)) || files.has(normalize(candidate))) { name = files.has(normalize(first)) ? first : candidate; caption = t.slice(t.indexOf('\n') === -1 ? t.length : t.indexOf('\n') + 1).trim(); }
    }
    if (!name) { const omitted = t.match(/^(?:<Media omitted>|(?:image|video|audio|sticker|document) omitted)[ \t]*(?:\n|$)/i); return omitted ? { name: /sticker omitted/i.test(omitted[0]) ? 'Sticker not included in this export' : 'Media not included in this export', kind: 'missing', caption: t.slice(omitted[0].length).trim(), entry: null } : null; }
    const matches = files?.get(normalize(name)) || files?.get(normalize(basename(name))) || [];
    const type = fileType(name);
    if (type.mime.startsWith('image/') && /\(sticker (?:file )?attached\)/i.test(t)) type.kind = 'sticker';
    return { name: basename(name), ...type, caption, entry: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
  }
  function parseChat(text, options = {}) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const headers = [];
    for (const line of lines) { const h = parseHeader(line); if (h) headers.push(h); }
    if (!headers.length) throw Error('No WhatsApp messages found. Choose the original exported chat .txt or .zip. Numeric Android and iPhone date formats are supported.');
    const { order, ambiguous } = decideOrder(headers, options.dateOrder);
    const messages = [], participants = new Set();
    let leadingLines = 0, invalidDates = 0, current = null;
    for (const line of lines) {
      const h = parseHeader(line);
      if (h) {
        if (messages.length >= LIMITS.messages) throw Error('This transcript exceeds 200,000 messages. Split the export before importing.');
        const date = parseDate(h, order);
        if (!date) { invalidDates++; current = null; continue; }
        const body = h.body, match = body.match(/^([^\n:]{1,180}):\s?([\s\S]*)$/);
        const sender = match ? match[1].trim() : null;
        if (sender) participants.add(sender);
        current = { id: messages.length, ...date, sender, text: match ? match[2] : body, system: !sender };
        messages.push(current);
      } else if (current) current.text += '\n' + line;
      else if (line.trim()) leadingLines++;
    }
    if (!messages.length) throw Error('Dates could not be read. Try Day / Month or Month / Day in Import settings.');
    for (const m of messages) { m.text = m.text.trimEnd(); m.attachment = attachment(m.text, options.files); m.search = normalize(`${m.sender || ''}\n${m.text}`); }
    return { messages, participants: [...participants], dateOrder: order, ambiguous, leadingLines, invalidDates };
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  async function readZip(file) {
    if (file.size > LIMITS.archive) throw Error('ZIP files must be 250 MB or smaller in this edition.');
    if (file.size < 22) throw Error('This ZIP file is empty or incomplete.');
    const tailStart = Math.max(0, file.size - 65557), tail = new DataView(await file.slice(tailStart).arrayBuffer());
    let end = -1;
    for (let p = tail.byteLength - 22; p >= 0; p--) if (tail.getUint32(p, true) === 0x06054b50 && p + 22 + tail.getUint16(p + 20, true) === tail.byteLength) { end = p; break; }
    if (end < 0) throw Error('This is not a complete ZIP archive. Re-export the chat from WhatsApp.');
    if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true) || tail.getUint16(end + 8, true) !== tail.getUint16(end + 10, true)) throw Error('Multi-part ZIP archives are not supported.');
    const count = tail.getUint16(end + 10, true), size = tail.getUint32(end + 12, true), offset = tail.getUint32(end + 16, true);
    if (count === 65535 || size === 0xffffffff || offset === 0xffffffff) throw Error('ZIP64 archives are not supported. Use a smaller original export.');
    if (count > LIMITS.entries || size > 16 * 1024 ** 2 || offset + size > tailStart + end) throw Error('ZIP directory exceeds the safety limits or is corrupt.');
    const dirBytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()), dir = new DataView(dirBytes.buffer), entries = [], names = new Set();
    let p = 0, total = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > size || dir.getUint32(p, true) !== 0x02014b50) throw Error('Corrupt ZIP file directory.');
      const flags = dir.getUint16(p + 8, true), method = dir.getUint16(p + 10, true), crc = dir.getUint32(p + 16, true), compressed = dir.getUint32(p + 20, true), uncompressed = dir.getUint32(p + 24, true), nl = dir.getUint16(p + 28, true), el = dir.getUint16(p + 30, true), cl = dir.getUint16(p + 32, true), local = dir.getUint32(p + 42, true);
      if (p + 46 + nl + el + cl > size) throw Error('Truncated ZIP directory.');
      const name = new TextDecoder('utf-8').decode(dirBytes.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/');
      p += 46 + nl + el + cl;
      if (flags & 1) throw Error('Password-protected ZIP files are not supported. Unzip locally, then import the original transcript.');
      if (name.includes('\0') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw Error('The ZIP contains an unsafe file path.');
      if (method !== 0 && method !== 8) throw Error('Unsupported ZIP compression. Use a standard stored or deflated ZIP.');
      if (uncompressed === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff || dir.getUint16(p - (46 + nl + el + cl) + 34, true)) throw Error('ZIP64 or multi-part entries are not supported.');
      total += uncompressed;
      if (uncompressed > LIMITS.entry || total > LIMITS.total || (uncompressed > 1024 ** 2 && uncompressed / Math.max(compressed, 1) > LIMITS.ratio)) throw Error('ZIP expansion exceeds the safety limits (100 MB per file, 750 MB total).');
      if (local + 30 > offset || local + compressed > offset) throw Error('Corrupt ZIP file offset.');
      if (name.endsWith('/') || name.startsWith('__MACOSX/') || basename(name).startsWith('.')) continue;
      if (names.has(normalize(name))) throw Error('The ZIP contains duplicate filenames. Import the original export instead.');
      names.add(normalize(name));
      entries.push({ name, flags, method, crc, compressed, size: uncompressed, local });
    }
    if (p !== size) throw Error('Unexpected data in ZIP directory.');
    return { file, entries, directoryOffset: offset };
  }
  async function extractEntry(zip, entry, maxSize = LIMITS.entry) {
    if (entry.size > maxSize) throw Error('This file exceeds the permitted size.');
    const h = new DataView(await zip.file.slice(entry.local, entry.local + 30).arrayBuffer());
    if (h.getUint32(0, true) !== 0x04034b50 || h.getUint16(8, true) !== entry.method || h.getUint16(6, true) & 1) throw Error('Corrupt ZIP local header.');
    const nameLen = h.getUint16(26, true), extraLen = h.getUint16(28, true), start = entry.local + 30 + nameLen + extraLen;
    if (start + entry.compressed > zip.directoryOffset) throw Error('Corrupt ZIP data bounds.');
    const localName = new TextDecoder().decode(await zip.file.slice(entry.local + 30, entry.local + 30 + nameLen).arrayBuffer()).replace(/\\/g, '/');
    if (localName !== entry.name) throw Error('ZIP filename mismatch.');
    let stream = zip.file.slice(start, start + entry.compressed).stream();
    if (entry.method === 8) {
      try { stream = stream.pipeThrough(new DecompressionStream('deflate-raw')); }
      catch { throw Error('Your browser does not support ZIP decompression. Use a current Chrome, Edge, Firefox, or Safari, or import a .txt file.'); }
    }
    const reader = stream.getReader(), chunks = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxSize || size > entry.size) { await reader.cancel(); throw Error('ZIP extraction exceeded its declared size.'); } chunks.push(value); }
    } catch (e) { try { await reader.cancel(); } catch {} throw e; }
    if (size !== entry.size) throw Error('ZIP file size verification failed.');
    const bytes = new Uint8Array(size); let i = 0; for (const c of chunks) { bytes.set(c, i); i += c.length; }
    if (crc32(bytes) !== entry.crc) throw Error('ZIP file checksum failed. The export may be damaged.');
    return bytes;
  }
  function mediaIndex(entries) {
    const map = new Map();
    for (const e of entries) for (const key of new Set([normalize(e.name), normalize(basename(e.name))])) { const a = map.get(key) || []; a.push(e); map.set(key, a); }
    return map;
  }
  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  function matchRanges(text, query, maximum = 100) {
    query = normalize(query); if (!query) return [];
    const segments = graphemes ? graphemes.segment(text) : Array.from(text.matchAll(/[\s\S]/gu), match => ({ segment: match[0], index: match.index }));
    let normalized = ''; const spans = [];
    for (const { segment, index } of segments) {
      const part = clean(segment).normalize('NFC'); normalized += part;
      for (let n = 0; n < part.toLowerCase().length; n++) spans.push([index, index + segment.length]);
    }
    normalized = normalized.toLowerCase();
    const ranges = []; let at = 0;
    while (ranges.length < maximum && (at = normalized.indexOf(query, at)) !== -1) {
      ranges.push([spans[at][0], spans[at + query.length - 1][1]]); at += query.length;
    }
    return ranges;
  }
  const api = { LIMITS, clean, normalize, basename, parseHeader, parseChat, fileType, emojiOnlyCount, readZip, extractEntry, mediaIndex, crc32, decodeText, matchRanges };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatCore = api;
})(typeof window === 'undefined' ? globalThis : window);
