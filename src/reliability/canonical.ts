import { createHash } from 'node:crypto';

const DEFAULT_MAX_JSON_BYTES = 1_048_576;
const DEFAULT_MAX_JSON_DEPTH = 128;
const MAX_CANONICAL_JSON_BYTES = 16_777_216;
const MAX_CANONICAL_JSON_DEPTH = 256;
const MAX_HASH_FIELD_BYTES = 1_048_576;
const MAX_HASH_FIELDS = 64;
const DOMAIN_TAG_PATTERN = /^[a-z][a-z0-9-]{0,63}:v[1-9][0-9]{0,8}$/u;

export type CanonicalJsonValue =
  null | boolean | string | number | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

export interface CanonicalJsonLimits {
  maxBytes?: number;
  maxDepth?: number;
}

type CanonicalProtocolErrorCode =
  | 'INVALID_CANONICAL_VALUE'
  | 'INVALID_JSON'
  | 'DUPLICATE_JSON_KEY'
  | 'NONCANONICAL_JSON'
  | 'INVALID_DOMAIN_TAG'
  | 'HASH_FIELD_TOO_LARGE'
  | 'INVALID_UTC_TIMESTAMP';

export class CanonicalProtocolError extends Error {
  readonly code: CanonicalProtocolErrorCode;

  constructor(code: CanonicalProtocolErrorCode, message: string) {
    super(message);
    this.name = 'CanonicalProtocolError';
    this.code = code;
  }
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  ceiling: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new CanonicalProtocolError(
      'INVALID_CANONICAL_VALUE',
      `${name} must be a positive safe integer no greater than ${ceiling}`
    );
  }
  return resolved;
}

function assertScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        throw new CanonicalProtocolError(
          'INVALID_CANONICAL_VALUE',
          `${label} contains an unpaired surrogate`
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalProtocolError(
        'INVALID_CANONICAL_VALUE',
        `${label} contains an unpaired surrogate`
      );
    }
  }
}

function assertDepth(depth: number, maximum: number): void {
  if (depth > maximum) {
    throw new CanonicalProtocolError(
      'INVALID_CANONICAL_VALUE',
      `Canonical JSON exceeds the maximum depth of ${maximum}`
    );
  }
}

interface CanonicalOutput {
  chunks: string[];
  remainingBytes: number;
}

function appendCanonical(output: CanonicalOutput, value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > output.remainingBytes) {
    throw new CanonicalProtocolError(
      'INVALID_CANONICAL_VALUE',
      'Canonical JSON exceeds its configured byte limit'
    );
  }
  output.remainingBytes -= bytes;
  output.chunks.push(value);
}

function appendCanonicalString(output: CanonicalOutput, value: string, label: string): void {
  assertScalarString(value, label);
  appendCanonical(output, '"');
  let chunk = '';

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const token = value[index] as string;
    if (token === '"') chunk += '\\"';
    else if (token === '\\') chunk += '\\\\';
    else if (token === '\b') chunk += '\\b';
    else if (token === '\f') chunk += '\\f';
    else if (token === '\n') chunk += '\\n';
    else if (token === '\r') chunk += '\\r';
    else if (token === '\t') chunk += '\\t';
    else if (code < 0x20) chunk += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code >= 0xd800 && code <= 0xdbff) {
      chunk += value.slice(index, index + 2);
      index += 1;
    } else chunk += token;

    if (chunk.length >= 4_096) {
      appendCanonical(output, chunk);
      chunk = '';
    }
  }

  if (chunk.length > 0) appendCanonical(output, chunk);
  appendCanonical(output, '"');
}

function appendCanonicalValue(
  value: unknown,
  depth: number,
  maximumDepth: number,
  ancestors: WeakSet<object>,
  output: CanonicalOutput
): void {
  assertDepth(depth, maximumDepth);

  if (value === null) {
    appendCanonical(output, 'null');
    return;
  }
  if (typeof value === 'boolean') {
    appendCanonical(output, value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'string') {
    appendCanonicalString(output, value, 'JSON string');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalProtocolError(
        'INVALID_CANONICAL_VALUE',
        'Canonical JSON rejects non-finite numbers'
      );
    }
    if (Object.is(value, -0)) {
      throw new CanonicalProtocolError(
        'INVALID_CANONICAL_VALUE',
        'Canonical JSON rejects negative zero'
      );
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalProtocolError(
        'INVALID_CANONICAL_VALUE',
        'Canonical JSON rejects unsafe integer values'
      );
    }
    appendCanonical(output, JSON.stringify(value));
    return;
  }
  if (typeof value !== 'object') {
    throw new CanonicalProtocolError(
      'INVALID_CANONICAL_VALUE',
      `Canonical JSON rejects values of type ${typeof value}`
    );
  }

  if (ancestors.has(value)) {
    throw new CanonicalProtocolError('INVALID_CANONICAL_VALUE', 'Canonical JSON rejects cycles');
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (ownKeys.length !== value.length) {
        throw new CanonicalProtocolError(
          'INVALID_CANONICAL_VALUE',
          'Canonical JSON rejects array holes, symbols, and extra properties'
        );
      }

      appendCanonical(output, '[');
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalProtocolError(
            'INVALID_CANONICAL_VALUE',
            'Canonical JSON rejects array holes'
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new CanonicalProtocolError(
            'INVALID_CANONICAL_VALUE',
            'Canonical JSON rejects array accessors and non-enumerable entries'
          );
        }
        if (index > 0) appendCanonical(output, ',');
        appendCanonicalValue(descriptor.value, depth + 1, maximumDepth, ancestors, output);
      }
      appendCanonical(output, ']');
      return;
    }

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalProtocolError(
        'INVALID_CANONICAL_VALUE',
        'Canonical JSON accepts plain objects only'
      );
    }

    const reflectedKeys = Reflect.ownKeys(value);
    if (reflectedKeys.some((key) => typeof key !== 'string')) {
      throw new CanonicalProtocolError(
        'INVALID_CANONICAL_VALUE',
        'Canonical JSON rejects symbol keys'
      );
    }
    const keys = (reflectedKeys as string[]).sort();
    appendCanonical(output, '{');
    for (const [index, key] of keys.entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new CanonicalProtocolError(
          'INVALID_CANONICAL_VALUE',
          'Canonical JSON rejects accessors and non-enumerable properties'
        );
      }
      if (index > 0) appendCanonical(output, ',');
      appendCanonicalString(output, key, 'JSON object key');
      appendCanonical(output, ':');
      appendCanonicalValue(descriptor.value, depth + 1, maximumDepth, ancestors, output);
    }
    appendCanonical(output, '}');
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: unknown, limits: CanonicalJsonLimits = {}): string {
  const maximumDepth = positiveBound(
    limits.maxDepth,
    DEFAULT_MAX_JSON_DEPTH,
    MAX_CANONICAL_JSON_DEPTH,
    'maxDepth'
  );
  const maximumBytes = positiveBound(
    limits.maxBytes,
    DEFAULT_MAX_JSON_BYTES,
    MAX_CANONICAL_JSON_BYTES,
    'maxBytes'
  );
  const output: CanonicalOutput = { chunks: [], remainingBytes: maximumBytes };
  appendCanonicalValue(value, 0, maximumDepth, new WeakSet(), output);
  return output.chunks.join('');
}

class StrictJsonParser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly maximumDepth: number
  ) {}

  parse(): CanonicalJsonValue {
    this.skipWhitespace();
    if (this.index === this.source.length) this.invalid('JSON input is empty');
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.invalid('JSON input contains trailing content');
    }
    return value;
  }

  private parseValue(depth: number): CanonicalJsonValue {
    if (depth > this.maximumDepth) {
      this.invalid(`JSON input exceeds the maximum depth of ${this.maximumDepth}`);
    }
    const token = this.source[this.index];
    if (token === '"') return this.parseString();
    if (token === '{') return this.parseObject(depth);
    if (token === '[') return this.parseArray(depth);
    if (token === 't') return this.parseLiteral('true', true);
    if (token === 'f') return this.parseLiteral('false', false);
    if (token === 'n') return this.parseLiteral('null', null);
    if (token === '-' || (token !== undefined && token >= '0' && token <= '9')) {
      return this.parseNumber();
    }
    this.invalid('JSON input contains an invalid value');
  }

  private parseObject(depth: number): { [key: string]: CanonicalJsonValue } {
    this.index += 1;
    this.skipWhitespace();
    const entries: [string, CanonicalJsonValue][] = [];
    const keys = new Set<string>();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return {};
    }

    while (this.index < this.source.length) {
      if (this.source[this.index] !== '"') this.invalid('JSON object key must be a string');
      const key = this.parseString();
      if (keys.has(key)) {
        throw new CanonicalProtocolError(
          'DUPLICATE_JSON_KEY',
          'JSON object contains a duplicate key'
        );
      }
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      entries.push([key, this.parseValue(depth + 1)]);
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === '}') {
        this.index += 1;
        return Object.fromEntries(entries);
      }
      this.expect(',');
      this.skipWhitespace();
    }
    this.invalid('JSON object is not closed');
  }

  private parseArray(depth: number): CanonicalJsonValue[] {
    this.index += 1;
    this.skipWhitespace();
    const values: CanonicalJsonValue[] = [];
    if (this.source[this.index] === ']') {
      this.index += 1;
      return values;
    }

    while (this.index < this.source.length) {
      values.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === ']') {
        this.index += 1;
        return values;
      }
      this.expect(',');
      this.skipWhitespace();
    }
    this.invalid('JSON array is not closed');
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      const token = this.source[this.index];
      if (token === '"') {
        this.index += 1;
        let value: string;
        try {
          value = JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          this.invalid('JSON string is invalid');
        }
        assertScalarString(value, 'JSON string');
        return value;
      }
      if (code < 0x20) this.invalid('JSON string contains an unescaped control character');
      if (token === '\\') {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === undefined) this.invalid('JSON string ends inside an escape');
        if (escape === 'u') {
          const digits = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) this.invalid('JSON unicode escape is invalid');
          this.index += 5;
          continue;
        }
        if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) {
          this.invalid('JSON string escape is invalid');
        }
      }
      this.index += 1;
    }
    this.invalid('JSON string is not closed');
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.source.slice(this.index)
    );
    if (match === null) this.invalid('JSON number is invalid');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.invalid('JSON number is not finite');
    if (Object.is(value, -0)) this.invalid('JSON number is negative zero');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      this.invalid('JSON integer exceeds the safe integer range');
    }
    return value;
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.invalid(`JSON literal ${literal} is invalid`);
    }
    this.index += literal.length;
    return value;
  }

  private expect(token: string): void {
    if (this.source[this.index] !== token) this.invalid(`JSON input expected ${token}`);
    this.index += 1;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === ' ' ||
      this.source[this.index] === '\t' ||
      this.source[this.index] === '\n' ||
      this.source[this.index] === '\r'
    ) {
      this.index += 1;
    }
  }

  private invalid(message: string): never {
    throw new CanonicalProtocolError(
      'INVALID_JSON',
      `${message} at character offset ${this.index}`
    );
  }
}

export function parseStrictJson(
  source: string,
  limits: CanonicalJsonLimits = {}
): CanonicalJsonValue {
  const maximumDepth = positiveBound(
    limits.maxDepth,
    DEFAULT_MAX_JSON_DEPTH,
    MAX_CANONICAL_JSON_DEPTH,
    'maxDepth'
  );
  const maximumBytes = positiveBound(
    limits.maxBytes,
    DEFAULT_MAX_JSON_BYTES,
    MAX_CANONICAL_JSON_BYTES,
    'maxBytes'
  );
  if (Buffer.byteLength(source, 'utf8') > maximumBytes) {
    throw new CanonicalProtocolError(
      'INVALID_JSON',
      `JSON input exceeds the maximum size of ${maximumBytes} bytes`
    );
  }
  return new StrictJsonParser(source, maximumDepth).parse();
}

export function assertCanonicalJson(
  source: string,
  limits: CanonicalJsonLimits = {}
): CanonicalJsonValue {
  const value = parseStrictJson(source, limits);
  if (canonicalizeJson(value, limits) !== source) {
    throw new CanonicalProtocolError('NONCANONICAL_JSON', 'JSON input is valid but noncanonical');
  }
  return value;
}

export function frameLengthPrefixedFields(domainTag: string, fields: readonly string[]): Buffer {
  if (!DOMAIN_TAG_PATTERN.test(domainTag)) {
    throw new CanonicalProtocolError(
      'INVALID_DOMAIN_TAG',
      'Domain tag must be a bounded lowercase name followed by :v and a positive version'
    );
  }
  if (fields.length > MAX_HASH_FIELDS) {
    throw new CanonicalProtocolError(
      'HASH_FIELD_TOO_LARGE',
      `Domain hash accepts at most ${MAX_HASH_FIELDS} fields`
    );
  }

  const chunks: Buffer[] = [];
  for (const [index, field] of [domainTag, ...fields].entries()) {
    if (typeof field !== 'string') {
      throw new CanonicalProtocolError(
        'INVALID_CANONICAL_VALUE',
        `Domain hash field ${index} must be a string`
      );
    }
    assertScalarString(field, `Domain hash field ${index}`);
    const bytes = Buffer.from(field, 'utf8');
    if (bytes.length > MAX_HASH_FIELD_BYTES) {
      throw new CanonicalProtocolError(
        'HASH_FIELD_TOO_LARGE',
        `Domain hash field ${index} exceeds ${MAX_HASH_FIELD_BYTES} bytes`
      );
    }
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

export function domainSeparatedSha256(domainTag: string, fields: readonly string[]): string {
  return createHash('sha256').update(frameLengthPrefixedFields(domainTag, fields)).digest('hex');
}

export function canonicalUtcTimestamp(value: string): string {
  if (typeof value !== 'string') {
    throw new CanonicalProtocolError('INVALID_UTC_TIMESTAMP', 'Timestamp must be a string');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (match === null) {
    throw new CanonicalProtocolError(
      'INVALID_UTC_TIMESTAMP',
      'Timestamp must be an exact UTC RFC 3339 instant ending in Z'
    );
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const canonicalInput = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(
    3,
    '0'
  )}Z`;
  const milliseconds = Date.parse(canonicalInput);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonicalInput) {
    throw new CanonicalProtocolError(
      'INVALID_UTC_TIMESTAMP',
      'Timestamp must be a real UTC RFC 3339 instant'
    );
  }
  return canonicalInput;
}
