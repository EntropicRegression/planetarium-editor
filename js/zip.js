// Minimal ZIP writer: stored (uncompressed) entries only. The images inside a pack are already
// compressed, and every unzip tool (including the app's importer) reads stored entries.
(function () {
  'use strict';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * @param {{name: string, data: Uint8Array}[]} files  name uses forward slashes
   * @returns {Uint8Array} the zip archive
   */
  function makeZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const UTF8_NAMES = 0x0800;

    const entries = files.map((file) => ({
      name: encoder.encode(file.name),
      data: file.data,
      crc: crc32(file.data),
      offset: 0,
    }));

    let size = 22;
    for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let pos = 0;

    for (const e of entries) {
      e.offset = pos;
      view.setUint32(pos, 0x04034b50, true);
      view.setUint16(pos + 4, 20, true);
      view.setUint16(pos + 6, UTF8_NAMES, true);
      view.setUint16(pos + 8, 0, true);
      view.setUint16(pos + 10, dosTime, true);
      view.setUint16(pos + 12, dosDate, true);
      view.setUint32(pos + 14, e.crc, true);
      view.setUint32(pos + 18, e.data.length, true);
      view.setUint32(pos + 22, e.data.length, true);
      view.setUint16(pos + 26, e.name.length, true);
      view.setUint16(pos + 28, 0, true);
      out.set(e.name, pos + 30);
      out.set(e.data, pos + 30 + e.name.length);
      pos += 30 + e.name.length + e.data.length;
    }

    const directoryStart = pos;
    for (const e of entries) {
      view.setUint32(pos, 0x02014b50, true);
      view.setUint16(pos + 4, 20, true);
      view.setUint16(pos + 6, 20, true);
      view.setUint16(pos + 8, UTF8_NAMES, true);
      view.setUint16(pos + 10, 0, true);
      view.setUint16(pos + 12, dosTime, true);
      view.setUint16(pos + 14, dosDate, true);
      view.setUint32(pos + 16, e.crc, true);
      view.setUint32(pos + 20, e.data.length, true);
      view.setUint32(pos + 24, e.data.length, true);
      view.setUint16(pos + 28, e.name.length, true);
      // extra length, comment length, disk number, internal attrs, external attrs: all zero
      view.setUint32(pos + 42, e.offset, true);
      out.set(e.name, pos + 46);
      pos += 46 + e.name.length;
    }

    view.setUint32(pos, 0x06054b50, true);
    view.setUint16(pos + 8, entries.length, true);
    view.setUint16(pos + 10, entries.length, true);
    view.setUint32(pos + 12, pos - directoryStart, true);
    view.setUint32(pos + 16, directoryStart, true);
    return out;
  }

  window.WallZip = { makeZip, crc32 };
})();
