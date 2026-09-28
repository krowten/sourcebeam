import { describe, expect, test } from 'bun:test';
import { isValidPath, isValidProjectId, parseJson, MAX_FILE_SIZE } from './index';

describe('isValidPath', () => {
  test.each(['src/main.py', 'README.md', 'a/b/c.txt', 'src/.gitignore', '.env.example', 'a/notes..bak'])('accepts %s', (p) =>
    expect(isValidPath(p)).toBe(true)
  );
  test.each(['', '/abs', '../up', 'a/../b', 'a//b', 'a\\b', '.', 'a/.', './foo', 'a/./b', 'x'.repeat(1025)])(
    'rejects %s', (p) => expect(isValidPath(p)).toBe(false)
  );
  test('rejects non-string inputs', () => {
    expect(isValidPath(null)).toBe(false);
    expect(isValidPath(undefined)).toBe(false);
    expect(isValidPath(42)).toBe(false);
    expect(isValidPath(['a.txt'])).toBe(false);
    expect(isValidPath({ path: 'a.txt' })).toBe(false);
  });
  test('length boundary: exactly 1024 accepted, 1025 rejected', () => {
    expect(isValidPath('x'.repeat(1024))).toBe(true);
    expect(isValidPath('x'.repeat(1025))).toBe(false);
  });
  test('rejects trailing and leading slashes via the empty-segment rule', () => {
    expect(isValidPath('a/')).toBe(false);
    expect(isValidPath('/')).toBe(false);
  });
  test('accepts unicode and spaces in segments', () => {
    expect(isValidPath('доки/заметки.md')).toBe(true);
    expect(isValidPath('my docs/read me.txt')).toBe(true);
  });
  test('segments that merely contain dots are fine, bare . / .. are not', () => {
    expect(isValidPath('a..b/c')).toBe(true);
    expect(isValidPath('...')).toBe(true); // three dots is a legal (if odd) name
    expect(isValidPath('a/..')).toBe(false);
  });
  test('rejects control characters, including NUL', () => {
    expect(isValidPath('a\0b')).toBe(false);
    expect(isValidPath('a\nb')).toBe(false);
    expect(isValidPath('a\x7fb')).toBe(false);
    expect(isValidPath('a\tb')).toBe(false);
  });
});

describe('isValidProjectId', () => {
  test.each(['python-basics', 'a1', 'a_b', 'snake_case_id'])('accepts %s', (s) =>
    expect(isValidProjectId(s)).toBe(true)
  );
  test.each(['', '-x', '_x', 'UPPER', 'x'.repeat(65)])('rejects %s', (s) =>
    expect(isValidProjectId(s)).toBe(false)
  );
  test('length boundary: 64 chars accepted, 65 rejected', () => {
    expect(isValidProjectId('a'.repeat(64))).toBe(true);
    expect(isValidProjectId('a'.repeat(65))).toBe(false);
  });
  test('single char and digit-leading ids are fine, hyphen/underscore-only lead is not', () => {
    expect(isValidProjectId('a')).toBe(true);
    expect(isValidProjectId('1abc')).toBe(true);
    expect(isValidProjectId('-')).toBe(false);
    expect(isValidProjectId('_')).toBe(false);
  });
  test('trailing hyphen/underscore is accepted (only the first char is restricted)', () => {
    expect(isValidProjectId('abc-')).toBe(true);
    expect(isValidProjectId('abc_')).toBe(true);
  });
});

describe('parseJson', () => {
  test('parses object', () => expect(parseJson('{"type":"subscribe"}')).toEqual({ type: 'subscribe' }));
  test.each(['not json', '[]', '"str"', 'null'])('returns null for %s', (raw) =>
    expect(parseJson(raw)).toBeNull()
  );
  test('parses ArrayBuffer', () =>
    expect(parseJson(new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer)).toEqual({ a: 1 }));
  test.each(['', '   ', '{', '{"a":1} trailing', '{a:1}', 'true', '42'])('returns null for %j', (raw) =>
    expect(parseJson(raw)).toBeNull()
  );
  test('empty object and whitespace-padded objects parse', () => {
    expect(parseJson('{}')).toEqual({});
    expect(parseJson('  {"a":1}\n')).toEqual({ a: 1 });
  });
  test('truncated/binary ArrayBuffer decodes lossily and fails the JSON parse', () => {
    expect(parseJson(new Uint8Array([0xff, 0xfe, 0x00]).buffer)).toBeNull();
    expect(parseJson(new TextEncoder().encode('{"a":').buffer as ArrayBuffer)).toBeNull();
  });
  test('preserves unicode content in values', () =>
    expect(parseJson('{"path":"доки/файл.md"}')).toEqual({ path: 'доки/файл.md' }));
});

test('MAX_FILE_SIZE is 512 KiB', () => expect(MAX_FILE_SIZE).toBe(524288));
