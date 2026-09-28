async function hmacHex(msg: string, secret: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signInvite(projectId: string, expiryUnix: number, viewSecret: ArrayBuffer): Promise<string> {
  const mac = await hmacHex(`${projectId}.${expiryUnix}`, viewSecret);
  return `${expiryUnix}.${mac}`;
}

/** Parses the unix-seconds expiry out of a `<expiry>.<mac>` token without checking the MAC —
 * null for anything structurally malformed. Used to attach an expiry to a live connection
 * (see project-room.ts) once verifyInvite has already accepted the token once. */
export function inviteExpiry(token: string): number | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const expiry = Number(token.slice(0, dot));
  return Number.isFinite(expiry) ? expiry : null;
}

export async function verifyInvite(
  token: string, projectId: string, viewSecret: ArrayBuffer, nowUnix: number
): Promise<boolean> {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const mac = token.slice(dot + 1);
  const expiry = inviteExpiry(token);
  if (expiry === null || expiry <= nowUnix) return false;
  const expected = await hmacHex(`${projectId}.${expiry}`, viewSecret);
  return timingSafeEqual(mac, expected);
}
