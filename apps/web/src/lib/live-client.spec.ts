import { describe, it, expect } from 'vitest';
import { shouldMarkInviteInvalid, resolveCloseBeforeMessage } from './live-client.svelte';

describe('shouldMarkInviteInvalid', () => {
	it('flags invite-invalid when the socket closed before any message', () => {
		expect(shouldMarkInviteInvalid({ gotMessageThisAttempt: false, projectDeleted: false })).toBe(
			true
		);
	});

	it('does not flag when a message (policy/tree) already arrived this attempt', () => {
		expect(shouldMarkInviteInvalid({ gotMessageThisAttempt: true, projectDeleted: false })).toBe(
			false
		);
	});

	it('does not flag a close that followed project_deleted, even without prior messages', () => {
		expect(shouldMarkInviteInvalid({ gotMessageThisAttempt: false, projectDeleted: true })).toBe(
			false
		);
	});

	it('project_deleted after a received message still suppresses the flag', () => {
		expect(shouldMarkInviteInvalid({ gotMessageThisAttempt: true, projectDeleted: true })).toBe(
			false
		);
	});
});

describe('resolveCloseBeforeMessage', () => {
	it('flags invite-invalid only for an explicit 403 from the auth probe', () => {
		expect(resolveCloseBeforeMessage(403)).toBe('invalid');
	});

	it.each([200, 204, 404, 503])('falls back to reconnect for any other status (%d)', (status) => {
		expect(resolveCloseBeforeMessage(status)).toBe('reconnect');
	});

	it('falls back to reconnect when the probe could not reach the server at all', () => {
		expect(resolveCloseBeforeMessage(null)).toBe('reconnect');
	});
});
