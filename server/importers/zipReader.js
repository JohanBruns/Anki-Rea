import zlib from 'node:zlib';

const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

export function isZip(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/** Minimal ZIP reader (stored + deflate, ZIP64 sizes) – enough for .apkg/.colpkg/.xlsx files. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Die ZIP-Datei ist beschädigt oder unvollständig.');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Ungültiges ZIP-Verzeichnis.');
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (compSize === 0xffffffff) (compSize = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    entries.set(name, { name, method, compSize, size, localOffset });
    p = extraEnd + commentLen;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const en = entries.get(name);
      if (!en) return null;
      const lh = en.localOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`Ungültiger ZIP-Eintrag: ${name}`);
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + en.compSize);
      if (en.method === 0) return data;
      if (en.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new Error(`Nicht unterstützte ZIP-Kompression (${en.method}) in ${name}.`);
    },
  };
}
