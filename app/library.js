(function (root) {
  'use strict';
  const C = root.ChatCore, te = new TextEncoder(), td = new TextDecoder();
  const canonicalName = s => C.normalize(s).replace(/^whatsapp chat (?:with\s+|[-–—]\s*)?/, '').replace(/\.(zip|rar|txt)$/i, '').replace(/\s*\(\d+\)$/, '').trim();
  function exportName(file, entry) { let n = C.basename(entry || file).replace(/\.txt$/i, ''); if (/^_?chat$/i.test(n)) n = C.basename(file).replace(/\.(zip|rar)$/i, ''); return n.replace(/^WhatsApp Chat (?:with |— |– |- )?/i, '').replace(/\s*\(\d+\)$/, '').trim() || 'Conversation'; }
  function messageKey(m) { return JSON.stringify([m.day, m.time, new Date(m.timestamp).getSeconds(), C.normalize(m.sender || ''), m.attachment ? ['MEDIA', C.normalize(m.attachment.name), (m.attachment.caption || '').normalize('NFC')] : m.text.normalize('NFC')]); }
  function mergeMessages(oldMessages, incoming) {
    // Match each occurrence, preserving repeated identical messages within the same minute.
    const queues = new Map(), used = new Set();
    oldMessages.forEach((m, i) => { const k = messageKey(m); if (!queues.has(k)) queues.set(k, { items: [], at: 0 }); queues.get(k).items.push(i); });
    let matched = 0, mediaRecovered = 0;
    const result = incoming.map(m => {
      const q = queues.get(messageKey(m)); let index;
      if (q) {
        while (q.at < q.items.length && used.has(q.items[q.at])) q.at++;
        for (let at = q.at; at < q.items.length; at++) {
          const candidate = q.items[at]; if (used.has(candidate)) continue;
          const left = oldMessages[candidate].attachment, right = m.attachment;
          const oldCRC = left?.crc ?? left?.entry?.crc, newCRC = right?.crc ?? right?.entry?.crc;
          if (oldCRC !== undefined && newCRC !== undefined && oldCRC !== newCRC) continue;
          index = candidate; break;
        }
      }
      if (index === undefined) return { ...m };
      used.add(index); matched++; const old = oldMessages[index];
      if (old.attachment?.sourceFile && !m.attachment?.sourceFile) { mediaRecovered++; return { ...m, attachment: { ...old.attachment, caption: m.attachment?.caption || old.attachment.caption } }; }
      return { ...m };
    });
    oldMessages.forEach((m, i) => { if (!used.has(i)) result.push({ ...m }); });
    if (used.size !== oldMessages.length) result.sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time) || a.timestamp - b.timestamp);
    result.forEach((m, i) => { m.id = i; });
    return { messages: result, added: result.length - oldMessages.length, matched, retained: oldMessages.length - matched, mediaRecovered, fullReplacement: matched === oldMessages.length };
  }
  function rawMessages(messages) { return messages.map(m => `${m.day}, ${m.time}:${String(new Date(m.timestamp).getSeconds()).padStart(2, '0')} - ${m.sender ? m.sender + ': ' : ''}${m.text}`).join('\n'); }
  function bindings(messages) { return messages.flatMap((m, i) => m.attachment ? [[i, { name: m.attachment.name, kind: m.attachment.kind, caption: m.attachment.caption || '', sourceFile: m.attachment.sourceFile || null, entryName: m.attachment.entryName || null, size: m.attachment.entry?.size || 0, crc: m.attachment.crc ?? m.attachment.entry?.crc }]] : []); }
  async function hash(file) { if (root.DMKProcessor) return root.DMKProcessor.run('hash', { file }); const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())); return [...h].map(x => x.toString(16).padStart(2, '0')).join(''); }
  const archiveRead = file => root.DMKProcessor ? root.DMKProcessor.run('archiveRead', { file }) : root.DMKArchives.read(file);
  const archiveExtract = (archive, entry, maxSize) => root.DMKProcessor ? root.DMKProcessor.run('archiveExtract', { archive, entry, maxSize }) : root.DMKArchives.extract(archive, entry, maxSize);
  class Library {
    constructor(vault) { this.vault = vault; this.cache = new Map(); }
    list() { return this.vault.index.chats.map(c => ({ ...c, messages: [], viewAs: c.viewAs || c.participants[0] || '', sample: false, disposed: false, loaded: false })); }
    async prepare(file, dateOrder = 'auto') {
      if (!/\.(txt|zip|rar)$/i.test(file.name)) throw Error('Choose a WhatsApp TXT, ZIP, or RAR export.');
      if (file.size > C.LIMITS.archive) throw Error('This export exceeds the 250 MB limit.');
      if (/\.txt$/i.test(file.name) && file.size > C.LIMITS.text) throw Error('TXT transcripts must be 20 MB or smaller.');
      const sourceHash = await hash(file), archive = /\.(zip|rar)$/i.test(file.name) ? await archiveRead(file) : null;
      const entries = archive ? archive.entries.filter(e => /\.txt$/i.test(e.name)) : [null];
      if (!entries.length || entries.length > 15) throw Error('Choose an archive containing 1–15 original WhatsApp TXT transcripts.');
      const media = archive ? C.mediaIndex(archive.entries.filter(e => !/\.txt$/i.test(e.name))) : null, imports = [];
      for (const entry of entries) {
        if (!entry && file.size > C.LIMITS.text) throw Error('TXT transcripts must be 20 MB or smaller.');
        const raw = C.decodeText(entry ? await archiveExtract(archive, entry, C.LIMITS.text) : new Uint8Array(await file.arrayBuffer()));
        const options = { dateOrder, files: media }, parsed = root.DMKProcessor ? await root.DMKProcessor.run('parse', { text: raw, options }) : C.parseChat(raw, options), name = exportName(file.name, entry?.name), matchName = canonicalName(name);
        const participants = new Set(parsed.participants.map(C.normalize));
        const sameParticipants = c => c.participants.length === participants.size && c.participants.every(p => participants.has(C.normalize(p)));
        const possible = this.vault.index.chats.filter(c => c.matchName === matchName || sameParticipants(c));
        const exact = possible.filter(c => c.matchName === matchName && sameParticipants(c));
        imports.push({ file, sourceHash, entryName: entry?.name || null, parsed, raw, media, name, matchName, exact: exact.length === 1 ? exact[0].id : null, possible: possible.map(c => ({ id: c.id, name: c.name, count: c.count })) });
      }
      return imports;
    }
    async open(id) {
      const meta = this.vault.index.chats.find(c => c.id === id); if (!meta) throw Error('Conversation not found.');
      const record = JSON.parse(td.decode(await this.vault.read(meta.dataFile)));
      if (!Array.isArray(record.bindings)) throw Error('Invalid saved conversation.');
      let parsed;
      if (record.version === 1 && typeof record.raw === 'string' && record.raw.length <= 50 * 1024 ** 2) parsed = C.parseChat(record.raw, { dateOrder: 'DMY' });
      else if (record.version === 2) {
        if (!Array.isArray(record.messages) || record.messages.length !== meta.count || record.messages.length > C.LIMITS.messages) throw Error('Invalid saved conversation.');
        const messages = record.messages.map((m, id) => {
          if (!m || typeof m.text !== 'string' || !Number.isFinite(m.timestamp) || !/^\d{4}-\d{2}-\d{2}$/.test(m.day) || !/^\d{2}:\d{2}$/.test(m.time) || !(m.sender === null || typeof m.sender === 'string' && m.sender.length <= 180)) throw Error('Invalid saved message.');
          return { ...m, id, system: !m.sender, attachment: null, search: C.normalize(`${m.sender || ''}\n${m.text}`) };
        });
        parsed = { messages, participants: [...new Set(messages.map(m => m.sender).filter(Boolean))], dateOrder: meta.dateOrder, invalidDates: 0, leadingLines: 0 };
      } else throw Error('Invalid saved conversation.');
      for (const [i, a] of record.bindings) { if (!Number.isInteger(i) || !parsed.messages[i] || !a || typeof a.name !== 'string' || !['image', 'sticker', 'video', 'audio', 'document', 'missing'].includes(a.kind) || a.sourceFile && !meta.sourceFiles.includes(a.sourceFile)) throw Error('Invalid saved attachment.'); parsed.messages[i].attachment = { ...a, mime: C.fileType(a.name).mime, entry: a.sourceFile ? { size: a.size || 0 } : null }; }
      return { ...meta, ...parsed, name: meta.name, dateOrder: meta.dateOrder, ambiguous: false, messages: parsed.messages, viewAs: meta.viewAs || parsed.participants[0] || '', loaded: true, disposed: false, sample: false, raw: record.raw, filename: 'Saved encrypted on this PC', libraryId: meta.id };
    }
    async import(item, targetId = item.exact) {
      const v = this.vault;
      return v.transaction(async () => {
        const target = targetId ? v.index.chats.find(c => c.id === targetId) : null;
        if (!target && v.index.chats.length >= 200) throw Error('This library supports up to 200 conversations.');
        if (target && target.imports?.includes(item.sourceHash + ':' + item.entryName)) return { duplicate: true, id: target.id, name: target.name, added: 0, count: target.count };
        const old = target ? await this.open(target.id) : null, source = Object.entries(v.index.sources).find(([, s]) => s.hash === item.sourceHash);
        const sourceFile = source?.[0] || 'src-' + crypto.randomUUID() + '.bin';
        for (const m of item.parsed.messages) if (m.attachment?.entry) m.attachment = { ...m.attachment, sourceFile, entryName: m.attachment.entry.name };
        const merged = old ? mergeMessages(old.messages, item.parsed.messages) : { messages: item.parsed.messages, added: item.parsed.messages.length, retained: 0, matched: 0, fullReplacement: false };
        if (merged.messages.length > C.LIMITS.messages) throw Error('The combined conversation exceeds 200,000 messages. Nothing was replaced.');
        const messageRecords = merged.messages.map(({ timestamp, day, time, sender, text }) => ({ timestamp, day, time, sender, text }));
        const encodedRecord = te.encode(JSON.stringify({ version: 2, messages: messageRecords, bindings: bindings(merged.messages) }));
        if (encodedRecord.length > 50 * 1024 ** 2) throw Error('Combined transcript is too large to save.');
        const dataFile = 'chat-' + crypto.randomUUID() + '.bin', id = target?.id || crypto.randomUUID(), actualSources = new Set(merged.messages.map(m => m.attachment?.sourceFile).filter(Boolean));
        // Keep the original export as well as its parsed transcript for completeness.
        actualSources.add(sourceFile);
        const participants = [...new Set(merged.messages.map(m => m.sender).filter(Boolean))];
        const last = merged.messages[merged.messages.length - 1], first = merged.messages[0];
        const meta = { id, dataFile, sourceFiles: [...actualSources], name: target?.name || item.name, matchName: target?.matchName || item.matchName, participants, count: merged.messages.length, mediaCount: merged.messages.filter(m => m.attachment).length, firstDay: first.day, lastDay: last.day, preview: `${last.sender ? last.sender + ': ' : ''}${last.attachment ? last.attachment.name : last.text}`.slice(0, 240), color: target?.color ?? v.index.chats.length % 5, viewAs: target?.viewAs || participants[0] || '', dateOrder: item.parsed.dateOrder, updatedAt: new Date().toISOString(), imports: [...(target?.imports || []), item.sourceHash + ':' + item.entryName].slice(-30) };
        if (target) { meta.previous = { ...target }; delete meta.previous.previous; }
        if (!source) await v.write(sourceFile, new Uint8Array(await item.file.arrayBuffer()));
        await v.write(dataFile, encodedRecord);
        const next = structuredClone(v.index); next.sources[sourceFile] = { hash: item.sourceHash, filename: item.file.name, size: item.file.size }; next.chats = next.chats.filter(c => c.id !== id); next.chats.push(meta); next.settings.active = id;
        await v.saveIndex(next); await v.cleanup().catch(() => {}); this.cache.clear();
        return { id, name: meta.name, count: meta.count, previousCount: target?.count || 0, updated: !!target, ...merged, messages: undefined };
      });
    }
    async attachment(a) {
      let archive = this.cache.get(a.sourceFile);
      if (!archive) {
        const source = this.vault.index.sources[a.sourceFile]; if (!source) throw Error('Attachment source is missing.');
        const file = new File([await this.vault.read(a.sourceFile)], source.filename), parsed = await archiveRead(file); archive = parsed;
        if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value); this.cache.set(a.sourceFile, archive);
      }
      const entry = archive.entries.find(e => e.name === a.entryName); if (!entry) throw Error('The saved attachment is missing from its export.'); return archiveExtract(archive, entry);
    }
    async preferences(id, changes) { await this.vault.change(index => { const c = index.chats.find(c => c.id === id); if (c) { if (changes.name) c.name = changes.name.slice(0, 200); if (changes.viewAs !== undefined) c.viewAs = changes.viewAs; } }); }
    async remove(id) { return this.vault.transaction(async v => { const index = structuredClone(v.index); index.chats = index.chats.filter(c => c.id !== id); if (index.settings.active === id) index.settings.active = null; await v.saveIndex(index); await v.cleanup(); this.cache.clear(); }); }
    async undo(id) { return this.vault.transaction(async v => { const index = structuredClone(v.index), at = index.chats.findIndex(c => c.id === id); if (at < 0 || !index.chats[at].previous) throw Error('There is no previous import to restore.'); index.chats[at] = index.chats[at].previous; await v.saveIndex(index); await v.cleanup(); this.cache.clear(); }); }
  }
  const api = { Library, canonicalName, exportName, messageKey, mergeMessages, rawMessages };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; root.DMKLibrary = api;
})(typeof window === 'undefined' ? globalThis : window);
