export * from './policy';
export * from './invite';

// Constants
export const DEBOUNCE_MS = 300;
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30000;

// Host (Watcher) Messages
export type SnapshotBegin = { type: 'snapshot_begin' };
export type FilePut = { type: 'file_put'; path: string; hash: string; content: string };
export type FileDelete = { type: 'file_delete'; path: string };
export type SnapshotEnd = { type: 'snapshot_end' };
export type MintInvite = { type: 'mint_invite'; ttlSeconds: number };
export type RotateViewSecret = { type: 'rotate_view_secret' };
export type DeleteProject = { type: 'delete_project' };

export type HostMessage =
  | SnapshotBegin
  | FilePut
  | FileDelete
  | SnapshotEnd
  | MintInvite
  | RotateViewSecret
  | DeleteProject;

// Viewer (Viewer) Messages
export type Subscribe = { type: 'subscribe'; path: string };

export type ViewerMessage = Subscribe;

// Server Messages
export type Tree = { type: 'tree'; paths: string[] };
export type TreeUpdate = { type: 'tree_update'; added: string[]; removed: string[] };
export type File = { type: 'file'; path: string; hash: string; content: string };
export type ErrorMsg = { type: 'error'; message: string };
export type Policy = { type: 'policy'; maxBytes: number };
export type ProjectDeleted = { type: 'project_deleted' };
export type Invite = { type: 'invite'; url: string; expiresAt: number };
export type Ok = { type: 'ok' };

export type ServerMessage = Tree | TreeUpdate | File | ErrorMsg | Policy | ProjectDeleted | Invite | Ok;

// Validation functions
// eslint-disable-next-line no-control-regex -- deliberately matching control bytes to reject them
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

export function isValidPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > 1024 || path.includes('\\') || CONTROL_CHAR.test(path)) {
    return false;
  }
  // Empty segment covers leading '/', '//' and trailing '/'.
  // Dotfiles ('.gitignore', '.env.example') are valid; '.' and '..' segments are not.
  return path.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');
}

export function isValidProjectId(id: string): boolean {
  const pattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  return pattern.test(id);
}

export function parseJson(raw: string | ArrayBuffer): Record<string, unknown> | null {
  try {
    let json: string;

    if (raw instanceof ArrayBuffer) {
      const decoder = new TextDecoder();
      json = decoder.decode(raw);
    } else {
      json = raw;
    }

    const parsed = JSON.parse(json);

    // Must be a plain object (not array, null, or primitive)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
