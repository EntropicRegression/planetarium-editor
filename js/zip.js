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

  /**
   * Reads a zip archive: resolves with [{ name, data }] for every file in it. Handles stored and
   * deflated entries (deflate through the browser's own DecompressionStream), which covers zips
   * made by this editor, by the phone app and by ordinary archive tools.
   */
  async function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The end-of-central-directory record is at the very end, before an optional comment.
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error('not a zip file');
    const count = view.getUint16(end + 10, true);
    let pos = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const files = [];
    for (let n = 0; n < count; n++) {
      if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) throw new Error('damaged zip file');
      const method = view.getUint16(pos + 10, true);
      const packedSize = view.getUint32(pos + 20, true);
      const nameLength = view.getUint16(pos + 28, true);
      const extraLength = view.getUint16(pos + 30, true);
      const commentLength = view.getUint16(pos + 32, true);
      const local = view.getUint32(pos + 42, true);
      const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength)).replace(/\\/g, '/');
      pos += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/')) continue; // a folder
      // The local header repeats the name and may carry a different amount of extra data.
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const packed = bytes.subarray(start, start + packedSize);
      let data;
      if (method === 0) {
        data = packed.slice();
      } else if (method === 8) {
        const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error(`"${name}" uses a compression method this editor cannot read`);
      }
      files.push({ name, data });
    }
    return files;
  }

  window.WallZip = { makeZip, readZip, crc32 };
})();
