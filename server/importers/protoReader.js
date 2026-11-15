// Tiny protobuf decoder for the few Anki blobs we need (deck configs, deck kinds, templates).

export function readProto(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const out = {};
  let i = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('Protobuf: unerwartetes Ende');
      const b = buf[i++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3;
    const wire = key & 7;
    let value;
    if (wire === 0) value = Number(varint());
    else if (wire === 1) {
      value = buf.subarray(i, i + 8);
      i += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      value = buf.subarray(i, i + len);
      i += len;
    } else if (wire === 5) {
      value = buf.readFloatLE(i);
      i += 4;
    } else throw new Error(`Protobuf: unbekannter Typ ${wire}`);
    (out[field] ||= []).push({ wire, value });
  }
  return out;
}

export function protoFloats(entries) {
  if (!entries) return undefined;
  const out = [];
  for (const e of entries) {
    if (e.wire === 5) out.push(e.value);
    else if (e.wire === 2) for (let i = 0; i + 4 <= e.value.length; i += 4) out.push(e.value.readFloatLE(i));
  }
  return out;
}

export const protoNumber = (entries) => (entries ? entries[entries.length - 1].value : undefined);
export const protoString = (entries) => (entries ? entries[0].value.toString('utf8') : undefined);
export const protoMessage = (entries) => (entries ? readProto(entries[0].value) : undefined);
