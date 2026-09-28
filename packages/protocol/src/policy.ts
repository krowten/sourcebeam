export const MAX_FILE_SIZE = 524288;

/** What the server publishes to every connection (the `policy` frame). Every text file the
 * project's .gitignore doesn't exclude is broadcast; this only carries the size cap, since the
 * other rules (text-only, no `.git/`) are fixed in code on both sides. */
export type FilePolicy = { maxBytes: number };

export const DEFAULT_POLICY: FilePolicy = { maxBytes: MAX_FILE_SIZE };

/** The one rule .gitignore can't override: git's own internals (any `.git` path segment) are
 * never project content. Everything else — `.env`, keys, tokens — is the project's call, made
 * in its .gitignore: a teaching project may well share a demo `.env` on purpose. */
export function isHardBlocked(path: string): boolean {
  return path.split('/').includes('.git');
}

/** Text means decodable as UTF-8 and free of NUL bytes — git's own binary heuristic. Clients
 * decode strictly, so a U+FFFD here means bytes were lost (or the file really contains one, rare
 * enough to treat the same). NUL is valid UTF-8, so it needs its own check. */
export function isText(content: string): boolean {
  return !content.includes('�') && !content.includes('\0');
}

export function isAllowedFile(path: string, byteLength: number, content: string, maxBytes = MAX_FILE_SIZE): boolean {
  if (!path || isHardBlocked(path)) return false;
  if (byteLength > maxBytes) return false;
  return isText(content);
}
