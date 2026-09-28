import { describe, expect, test } from 'bun:test';
import { inviteExpiry, signInvite, verifyInvite } from './invite';

const secret = () => crypto.getRandomValues(new Uint8Array(32)).buffer;

describe('invite tokens', () => {
  test('round-trip valid', async () => {
    const s = secret(); const exp = 2000;
    const t = await signInvite('proj', exp, s);
    expect(await verifyInvite(t, 'proj', s, 1000)).toBe(true);
  });
  test('rejects expired', async () => {
    const s = secret();
    const t = await signInvite('proj', 1000, s);
    expect(await verifyInvite(t, 'proj', s, 1001)).toBe(false);
  });
  test('rejects wrong project', async () => {
    const s = secret();
    const t = await signInvite('proj', 2000, s);
    expect(await verifyInvite(t, 'other', s, 1000)).toBe(false);
  });
  test('rejects wrong secret', async () => {
    const t = await signInvite('proj', 2000, secret());
    expect(await verifyInvite(t, 'proj', secret(), 1000)).toBe(false);
  });
  test('rejects malformed', async () => {
    const s = secret();
    expect(await verifyInvite('garbage', 'proj', s, 1000)).toBe(false);
    expect(await verifyInvite('', 'proj', s, 1000)).toBe(false);
  });
  test('expiry boundary: valid one second before expiry, invalid exactly at it', async () => {
    const s = secret();
    const t = await signInvite('proj', 2000, s);
    expect(await verifyInvite(t, 'proj', s, 1999)).toBe(true);
    expect(await verifyInvite(t, 'proj', s, 2000)).toBe(false);
  });
  test('rejects a tampered mac (single hex digit flipped)', async () => {
    const s = secret();
    const t = await signInvite('proj', 2000, s);
    const mac = t.slice(t.indexOf('.') + 1);
    const flipped = (mac[0] === '0' ? '1' : '0') + mac.slice(1);
    expect(await verifyInvite(`2000.${flipped}`, 'proj', s, 1000)).toBe(false);
  });
  test('rejects a valid mac paired with a different expiry', async () => {
    const s = secret();
    const t = await signInvite('proj', 2000, s);
    const mac = t.slice(t.indexOf('.') + 1);
    expect(await verifyInvite(`9999.${mac}`, 'proj', s, 1000)).toBe(false);
  });
  test('rejects structural edge cases', async () => {
    const s = secret();
    const t = await signInvite('proj', 2000, s);
    const mac = t.slice(t.indexOf('.') + 1);
    expect(await verifyInvite(`.${mac}`, 'proj', s, 1000)).toBe(false); // empty expiry (dot at 0)
    expect(await verifyInvite('2000.', 'proj', s, 1000)).toBe(false); // empty mac
    expect(await verifyInvite('2000', 'proj', s, 1000)).toBe(false); // no dot at all
    expect(await verifyInvite(`NaN.${mac}`, 'proj', s, 1000)).toBe(false); // non-numeric expiry
    expect(await verifyInvite(`Infinity.${mac}`, 'proj', s, 1000)).toBe(false); // non-finite expiry
    expect(await verifyInvite(`-2000.${mac}`, 'proj', s, 1000)).toBe(false); // negative -> already expired
  });
  test('rejects a token for the same expiry signed against another project (prefix collision)', async () => {
    // 'a.1' + expiry vs 'a' + '1<expiry>' style ambiguity: the mac input is `${project}.${expiry}`,
    // so shifting the dot must never validate across projects.
    const s = secret();
    const t = await signInvite('a.1', 2000, s);
    expect(await verifyInvite(t, 'a', s, 1000)).toBe(false);
  });
});

describe('inviteExpiry', () => {
  test('reads the expiry without checking the mac', async () => {
    const t = await signInvite('proj', 2000, secret());
    expect(inviteExpiry(t)).toBe(2000);
    expect(inviteExpiry('2000.garbage-mac')).toBe(2000);
  });
  test('null for structurally malformed tokens', () => {
    expect(inviteExpiry('garbage')).toBeNull();
    expect(inviteExpiry('')).toBeNull();
    expect(inviteExpiry('.mac')).toBeNull();
    expect(inviteExpiry('NaN.mac')).toBeNull();
  });
});
