const assert = require('node:assert/strict'), C = require('../app/core.js');
function storedZip(entries) {
  const locals = [], directory = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name), data = Buffer.from(item.text || ''), crc = C.crc32(data), local = Buffer.alloc(30 + name.length), central = Buffer.alloc(46 + name.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6); local.writeUInt32LE(crc,14); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26); name.copy(local,30);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x800,8); central.writeUInt32LE(crc,16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42); name.copy(central,46);
    locals.push(local,data); directory.push(central); offset += local.length + data.length;
  }
  const end = Buffer.alloc(22), size = directory.reduce((n,b)=>n+b.length,0); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(size,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,...directory,end]);
}
module.exports = async function archiveTests() {
  const bytes = storedZip([{name:'folder/_chat.txt',text:'Synthetic text'},{name:'画像.png',text:'image bytes'}]);
  const zip = await C.readZip(new File([bytes],'fixture.zip'));
  assert.equal(new TextDecoder().decode(await C.extractEntry(zip,zip.entries[0])), 'Synthetic text'); assert.equal(zip.entries[1].name,'画像.png');
  for (const name of ['../escape.txt','/absolute.txt','C:/absolute.txt','folder/../escape.txt']) await assert.rejects(C.readZip(new File([storedZip([{name,text:'test'}])],'unsafe.zip')), /unsafe/);
  await assert.rejects(C.readZip(new File([storedZip([{name:'same.txt'},{name:'SAME.txt'}])],'duplicate.zip')), /duplicate/);
  const corrupt = bytes.slice(); corrupt[30 + Buffer.byteLength('folder/_chat.txt')] ^= 1;
  const corruptedZip = await C.readZip(new File([corrupt],'corrupt.zip')); await assert.rejects(C.extractEntry(corruptedZip,corruptedZip.entries[0]), /checksum/);
  await assert.rejects(C.readZip(new File([bytes.subarray(0,bytes.length-10)],'truncated.zip')), /complete/);
  await assert.rejects(C.extractEntry(zip,zip.entries[0],1), /permitted/);
  console.log('Archive regression checks passed: ZIP extraction, UTF-8 names, path traversal, duplicate names, corruption, truncation and extraction bounds.');
};
module.exports.storedZip = storedZip;
