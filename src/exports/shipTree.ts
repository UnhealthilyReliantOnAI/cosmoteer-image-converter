import { ShipExportError } from './shipErrors';

export type ShipNode =
  | {
  readonly tag: 0 | 5;
}
  | {
  readonly tag: 1;
  readonly data: Uint8Array;
}
  | {
  readonly tag: 2;
  readonly items: readonly ShipNode[];
}
  | {
  readonly tag: 3;
  readonly entries: readonly (readonly [string, ShipNode])[];
};

export interface ShipTreeLimits {
  readonly maxBytes: number;
  readonly maxPrimitiveBytes: number;
  readonly maxKeyBytes: number;
  readonly maxEntries: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  /** Unconfirmed 3/4-byte counters and long/non-ASCII keys are opt-in synthetic features. */
  readonly allowExperimentalEncodings: boolean;
}

export const DEFAULT_TREE_LIMITS: ShipTreeLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxPrimitiveBytes: 64 * 1024 * 1024,
  maxKeyBytes: 1024 * 1024,
  maxEntries: 1_000_000,
  maxNodes: 1_000_000,
  maxDepth: 100,
  allowExperimentalEncodings: false,
};

const utf8Encoder = new TextEncoder();

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const fail = (message: string): never => {
  throw new ShipExportError('E_TREE', message);
};

function checkedLimits(options: Partial<ShipTreeLimits>): ShipTreeLimits {
  const limits = { ...DEFAULT_TREE_LIMITS, ...options };
  for (const [key, value] of Object.entries(limits)) {
    if (key === 'allowExperimentalEncodings') {
      if (typeof value !== 'boolean') fail('Experimental encoding option must be boolean.');
    } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      fail('Tree limits must be non-negative safe integers.');
    }
  }
  return limits;
}

export function encodeUtf8(text: string): Uint8Array {
  if (typeof text !== 'string') return fail('Expected text.');
  // TextEncoder replaces unpaired UTF-16 surrogates; reject rather than silently changing text.
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = text.charCodeAt(++index);
      if (!(following >= 0xdc00 && following <= 0xdfff)) fail('Unpaired UTF-16 surrogate.');
    } else if (code >= 0xdc00 && code <= 0xdfff) fail('Unpaired UTF-16 surrogate.');
  }
  return utf8Encoder.encode(text);
}

/** Canonical node counter, distinct from the 7-bit UTF-8 length prefix. */
export function encodeCount(value: number, allowExperimentalEncodings = false): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 536_870_911) fail('Invalid tree counter.');
  let width: number;
  let word: number;
  if (value <= 127) {
    width = 1;
    word = value * 2;
  }
  else if (value <= 16383) {
    width = 2;
    word = value * 4 + 1;
  }
  else {
    if (!allowExperimentalEncodings) fail('Unconfirmed counter widths require explicit opt-in.');
    if (value <= 2097151) {
      width = 3;
      word = value * 8 + 3;
    }
    else {
      width = 4;
      word = value * 8 + 7;
    }
  }
  const result = new Uint8Array(width);
  for (let index = 0; index < width; index++) result[index] = Math.floor(word / 2 ** (8 * index)) % 256;
  return result;
}

export function encodeTextLength(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail('Invalid text length.');
  const values: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    values.push(byte + (value ? 128 : 0));
  } while (value);
  return new Uint8Array(values);
}

export function packedText(text: string): Uint8Array {
  const bytes = encodeUtf8(text);
  const prefix = encodeTextLength(bytes.length);
  const result = new Uint8Array(prefix.length + bytes.length);
  result.set(prefix);
  result.set(bytes, prefix.length);
  return result;
}

export const primitive = (data: Uint8Array): ShipNode => ({ tag: 1, data });

export const listNode = (items: readonly ShipNode[]): ShipNode => ({ tag: 2, items });

export const mapNode = (entries: readonly (readonly [string, ShipNode])[]): ShipNode => ({ tag: 3, entries });

export const unsetNode = (): ShipNode => ({ tag: 0 });

export const nullNode = (): ShipNode => ({ tag: 5 });

export const textNode = (text: string): ShipNode => primitive(packedText(text));

export function int32Node(value: number): ShipNode {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail('Invalid signed int32 primitive.');
  const data = new Uint8Array(4);
  new DataView(data.buffer).setInt32(0, value, true);
  return primitive(data);
}

export function byteNode(value: number): ShipNode {
  if (!Number.isInteger(value) || value < 0 || value > 255) fail('Invalid byte primitive.');
  return primitive(new Uint8Array([value]));
}

export function float4Node(a: number, b: number, c: number, d: number): ShipNode {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  [a, b, c, d].forEach((value, index) => {
    if (!Number.isFinite(value)) fail('Invalid float32 primitive.');
    view.setFloat32(index * 4, value, true);
    if (!Number.isFinite(view.getFloat32(index * 4, true))) fail('Float32 overflow.');
  });
  return primitive(data);
}

interface Plan {
  readonly tag: number;
  readonly size: number;
  readonly prefix?: Uint8Array;
  readonly data?: Uint8Array;
  readonly children?: readonly Plan[];
  readonly keys?: readonly Uint8Array[];
}

function encodedKey(key: string, limits: ShipTreeLimits): Uint8Array {
  const data = encodeUtf8(key);
  if (data.length > limits.maxKeyBytes) fail('Key exceeds the configured size limit.');
  if (!limits.allowExperimentalEncodings && (data.length >= 128 || data.some((byte) => byte >= 128))) {
    fail('Long or non-ASCII keys require explicit experimental opt-in.');
  }
  const prefix = encodeTextLength(data.length);
  const result = new Uint8Array(prefix.length + data.length);
  result.set(prefix);
  result.set(data, prefix.length);
  return result;
}

/** Measure first, then write once into an exact allocation; lists/maps retain their order. */
export function serializeTree(root: ShipNode, options: Partial<ShipTreeLimits> = {}): Uint8Array {
  const limits = checkedLimits(options);
  const active = new Set<object>();
  let nodes = 0;
  const measure = (value: ShipNode, depth: number): Plan => {
    if (depth > limits.maxDepth || ++nodes > limits.maxNodes) fail('Tree complexity limit exceeded.');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('Invalid tree node.');
    if (active.has(value)) fail('Cyclic tree.');
    active.add(value);
    let plan: Plan;
    switch (value.tag) {
    case 0: case 5: plan = { tag: value.tag, size: 1 };

    break;
    case 1: {
      if (!(value.data instanceof Uint8Array)) return fail('Primitive data must be bytes.');
      if (value.data.length > limits.maxPrimitiveBytes) fail('Primitive size limit exceeded.');
      const prefix = encodeCount(value.data.length, limits.allowExperimentalEncodings);
      plan = { tag: 1, prefix, data: value.data, size: 1 + prefix.length + value.data.length };
      break;
    }
    case 2: {
      if (!Array.isArray(value.items) || value.items.length > limits.maxEntries) return fail('Invalid list size.');
      const prefix = encodeCount(value.items.length, limits.allowExperimentalEncodings);
      const children = value.items.map((item) => measure(item, depth + 1));
      plan = {
        tag: 2,
        prefix,
        children,
        size: 1 + prefix.length + children.reduce((sum, item) => sum + item.size, 0),
      };
      break;
    }
    case 3: {
      if (!Array.isArray(value.entries) || value.entries.length > limits.maxEntries) return fail('Invalid map size.');
      const prefix = encodeCount(value.entries.length, limits.allowExperimentalEncodings);
      const keys: Uint8Array[] = [];
      const children: Plan[] = [];
      const seen = new Set<string>();
      for (const entry of value.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') fail('Invalid map entry.');
        const [key, child] = entry;
        if (seen.has(key)) fail('Duplicate map key.');
        seen.add(key);
        keys.push(encodedKey(key, limits));
        children.push(measure(child, depth + 1));
      }
      plan = {
        tag: 3,
        prefix,
        keys,
        children,
        size: 1 + prefix.length
          + children.reduce((sum, item, index) => sum + keys[index]!.length + item.size, 0),
      };
      break;
    }
    default: return fail('Unsupported tree tag.');
    }
    active.delete(value);
    if (plan.size > limits.maxBytes) fail('Tree byte limit exceeded.');
    return plan;
  };
  const plan = measure(root, 0);
  const result = new Uint8Array(plan.size);
  let cursor = 0;
  const writeBytes = (bytes: Uint8Array) => {
    result.set(bytes, cursor);
    cursor += bytes.length;
  };
  const write = (item: Plan): void => {
    result[cursor++] = item.tag;
    if (item.prefix) writeBytes(item.prefix);
    if (item.data) writeBytes(item.data);
    item.children?.forEach((child, index) => {
      if (item.keys) writeBytes(item.keys[index]!);
      write(child);
    });
  };
  write(plan);
  if (cursor !== result.length) fail('Tree length mismatch.');
  return result;
}

class TreeReader {
  cursor = 0;
  nodes = 0;
  constructor(readonly bytes: Uint8Array, readonly limits: ShipTreeLimits) {}
  byte(): number {
    if (this.cursor >= this.bytes.length) return fail('Truncated tree.');
    return this.bytes[this.cursor++]!;
  }
  readBytes(length: number): Uint8Array {
    if (length > this.bytes.length - this.cursor) return fail('Truncated tree body.');
    const bytes = this.bytes.slice(this.cursor, this.cursor + length);
    this.cursor += length;
    return bytes;
  }
  count(): number {
    const first = this.byte();
    const width = first % 2 === 0 ? 1 : first % 4 === 1 ? 2 : first % 8 === 3 ? 3 : 4;
    if (width > 2 && !this.limits.allowExperimentalEncodings) fail('Unconfirmed counter width.');
    let word = first;
    for (let index = 1; index < width; index++) word += this.byte() * 2 ** (index * 8);
    const count = Math.floor(word / 2 ** (width === 1 ? 1 : width === 2 ? 2 : 3));
    if (encodeCount(count, this.limits.allowExperimentalEncodings).length !== width) fail('Non-minimal tree counter.');
    return count;
  }
  textLength(): number {
    let length = 0;
    for (let index = 0; index < 5; index++) {
      const byte = this.byte();
      length += (byte % 128) * 128 ** index;
      if (length > 0xffffffff) fail('Text length overflow.');
      if (byte < 128) {
        if (index > 0 && byte === 0) fail('Non-minimal text prefix.');
        return length;
      }
    }
    return fail('Text length prefix too long.');
  }
  key(): string {
    const length = this.textLength();
    if (length > this.limits.maxKeyBytes) fail('Key size limit exceeded.');
    const bytes = this.readBytes(length);
    if (!this.limits.allowExperimentalEncodings && (length >= 128 || bytes.some((byte) => byte >= 128))) {
      fail('Unconfirmed key encoding.');
    }
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      return fail('Invalid key UTF-8.');
    }
  }
  node(depth: number): ShipNode {
    if (depth > this.limits.maxDepth || ++this.nodes > this.limits.maxNodes) fail('Tree complexity limit exceeded.');
    const tag = this.byte();
    switch (tag) {
    case 0: return unsetNode();
    case 5: return nullNode();
    case 1: {
      const length = this.count();
      if (length > this.limits.maxPrimitiveBytes) fail('Primitive size limit exceeded.');
      return primitive(this.readBytes(length));
    }
    case 2: {
      const count = this.count();
      if (count > this.limits.maxEntries) fail('List size limit exceeded.');
      const items: ShipNode[] = [];
      for (let index = 0; index < count; index++) items.push(this.node(depth + 1));
      return listNode(items);
    }
    case 3: {
      const count = this.count();
      if (count > this.limits.maxEntries) fail('Map size limit exceeded.');
      const entries: [string, ShipNode][] = [];
      const seen = new Set<string>();
      for (let index = 0; index < count; index++) {
        const key = this.key();
        if (seen.has(key)) fail('Duplicate map key.');
        seen.add(key);
        entries.push([key, this.node(depth + 1)]);
      }
      return mapNode(entries);
    }
    default: return fail('Unsupported tree tag.');
    }
  }
}

export function decodeCount(bytes: Uint8Array, allowExperimentalEncodings = false): number {
  if (!(bytes instanceof Uint8Array)) return fail('Expected bytes.');
  const reader = new TreeReader(bytes, { ...DEFAULT_TREE_LIMITS, allowExperimentalEncodings });
  const count = reader.count();
  if (reader.cursor !== bytes.length) fail('Trailing counter bytes.');
  return count;
}
/** Diagnostic/conformance reader; the export runtime need not parse its tree a second time. */
export function parseTree(bytes: Uint8Array, options: Partial<ShipTreeLimits> = {}): ShipNode {
  const limits = checkedLimits(options);
  if (!(bytes instanceof Uint8Array) || bytes.length > limits.maxBytes) return fail('Invalid tree buffer size.');
  const reader = new TreeReader(bytes, limits);
  const root = reader.node(0);
  if (reader.cursor !== bytes.length) fail('Trailing tree bytes.');
  return root;
}
