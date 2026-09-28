import { describe, expect, test } from 'bun:test';
import { isAllowedFile, isHardBlocked, isText, MAX_FILE_SIZE } from './policy';

describe('isAllowedFile', () => {
  test('accepts any text file, whatever its name or extension', () => {
    for (const name of ['src/main.py', 'Dockerfile', '.gitignore', '.prettierrc', '.editorconfig', 'LICENSE', 'notes.weird-ext', 'icon.svg', 'weird.']) {
      expect(isAllowedFile(name, 2, '{}')).toBe(true);
    }
  });
  test('rejects binary content: a NUL byte or a lossy-decode marker', () => {
    expect(isAllowedFile('image.png', 5, 'PNG\0x')).toBe(false);
    expect(isAllowedFile('a.txt', 5, 'a�b')).toBe(false);
  });
  test('MAX is 512 KiB; accepts exactly at the cap, rejects one over', () => {
    expect(MAX_FILE_SIZE).toBe(524288);
    expect(isAllowedFile('a.js', MAX_FILE_SIZE, 'x')).toBe(true);
    expect(isAllowedFile('a.js', MAX_FILE_SIZE + 1, 'x')).toBe(false);
  });
  test('a smaller server cap is honored', () => expect(isAllowedFile('a.js', 11, 'x', 10)).toBe(false));
  test('accepts empty content (zero bytes)', () => expect(isAllowedFile('empty.txt', 0, '')).toBe(true));
  test('empty path is rejected', () => expect(isAllowedFile('', 0, '')).toBe(false));
  test('unicode path is accepted', () => expect(isAllowedFile('доки/заметки.md', 4, 'x')).toBe(true));
});

describe('isHardBlocked', () => {
  test('.git must be a whole path segment', () => {
    expect(isHardBlocked('x/.git/notes.md')).toBe(true);
    expect(isHardBlocked('deep/.git/hooks/pre-commit.sh')).toBe(true);
    expect(isHardBlocked('a.git/b.ts')).toBe(false);
    expect(isHardBlocked('.github/workflows/ci.yml')).toBe(false);
  });
  test('.env, keys and token files are the project\'s call via .gitignore, not blocked here', () => {
    for (const name of ['.env', 'a/b/.env.production', '.env.example', 'certs/localhost.pem', 'id_rsa', '.npmrc']) {
      expect(isHardBlocked(name)).toBe(false);
      expect(isAllowedFile(name, 3, 'x=1')).toBe(true);
    }
  });
});

describe('isText', () => {
  test('plain text, including non-ASCII, is text', () => expect(isText('héllo — ok')).toBe(true));
  test('NUL or U+FFFD is not', () => {
    expect(isText('a\0b')).toBe(false);
    expect(isText('a�b')).toBe(false);
  });
});
