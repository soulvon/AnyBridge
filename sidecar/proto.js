// proto.js — Low-level protobuf wire format encoder/decoder (no schema needed)

// ─── Varint ────────────────────────────────────────────────

export function encodeVarint(value) {
  const bytes = [];
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) v = v + (1n << 64n); // handle negative as unsigned
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

export function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, bytesRead: pos - offset };
}

// ─── Field writers ─────────────────────────────────────────

function fieldTag(fieldNum, wireType) {
  return encodeVarint((fieldNum << 3) | wireType);
}

/** Wire type 0 — varint */
export function writeVarintField(fieldNum, value) {
  return Buffer.concat([fieldTag(fieldNum, 0), encodeVarint(value)]);
}

/** Wire type 2 — length-delimited bytes */
export function writeBytesField(fieldNum, buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Buffer.concat([fieldTag(fieldNum, 2), encodeVarint(data.length), data]);
}

/** Wire type 2 — length-delimited string */
export function writeStringField(fieldNum, str) {
  return writeBytesField(fieldNum, Buffer.from(str, 'utf8'));
}

/** Wire type 2 — nested message (already serialized) */
export function writeMessageField(fieldNum, messageBuf) {
  return writeBytesField(fieldNum, messageBuf);
}

/** Wire type 1 — fixed 64-bit */
export function writeFixed64Field(fieldNum, buf8) {
  return Buffer.concat([fieldTag(fieldNum, 1), buf8]);
}

/** Wire type 5 — fixed 32-bit */
export function writeFixed32Field(fieldNum, buf4) {
  return Buffer.concat([fieldTag(fieldNum, 5), buf4]);
}

// ─── Field reader / parser ─────────────────────────────────

/**
 * Parse a protobuf buffer into an array of {field, wireType, value} objects.
 * For wire type 2, value is a raw Buffer (caller decides how to interpret).
 */
export function parseFields(buf) {
  const fields = [];
  let offset = 0;

  while (offset < buf.length) {
    const tagResult = decodeVarint(buf, offset);
    offset += tagResult.bytesRead;
    const tag = tagResult.value;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 7n);

    if (fieldNum === 0) break;

    switch (wireType) {
      case 0: { // varint
        const vr = decodeVarint(buf, offset);
        offset += vr.bytesRead;
        fields.push({ field: fieldNum, wireType: 0, value: Number(vr.value) });
        break;
      }
      case 1: { // fixed64
        if (offset + 8 > buf.length) return fields; // 截断，停止解析
        fields.push({ field: fieldNum, wireType: 1, value: buf.slice(offset, offset + 8) });
        offset += 8;
        break;
      }
      case 2: { // length-delimited
        const lr = decodeVarint(buf, offset);
        offset += lr.bytesRead;
        const len = Number(lr.value);
        // 长度越界/为负 → 截断或恶意帧，停止解析避免后续 tag 错位。
        if (len < 0 || offset + len > buf.length) return fields;
        fields.push({ field: fieldNum, wireType: 2, value: buf.slice(offset, offset + len) });
        offset += len;
        break;
      }
      case 5: { // fixed32
        if (offset + 4 > buf.length) return fields; // 截断，停止解析
        fields.push({ field: fieldNum, wireType: 5, value: buf.slice(offset, offset + 4) });
        offset += 4;
        break;
      }
      default:
        // Unknown wire type — stop parsing
        return fields;
    }
  }

  return fields;
}

/**
 * Get first field with given number, optionally filter by wire type.
 */
export function getField(fields, fieldNum, wireType) {
  return fields.find(f => f.field === fieldNum && (wireType === undefined || f.wireType === wireType));
}

/**
 * Get all fields with given number.
 */
export function getAllFields(fields, fieldNum) {
  return fields.filter(f => f.field === fieldNum);
}

/**
 * Read a string from a wire-type-2 field value (Buffer).
 */
export function fieldToString(field) {
  if (!field || field.wireType !== 2) return '';
  return field.value.toString('utf8');
}

/**
 * Read a varint from a wire-type-0 field value.
 */
export function fieldToInt(field) {
  if (!field || field.wireType !== 0) return 0;
  return field.value;
}
