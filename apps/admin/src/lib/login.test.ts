import { describe, expect, it } from 'vitest';
import { loginFailureMessage } from './login.js';

describe('loginFailureMessage', () => {
	it('explains bad credentials without leaking which half was wrong', () => {
		expect(loginFailureMessage(401)).toBe('That user and password don’t match — try again.');
	});

	it('turns Retry-After seconds into minutes, rounding up', () => {
		expect(loginFailureMessage(429, 290)).toBe('Too many attempts — try again in 5 minutes.');
		expect(loginFailureMessage(429, 30)).toBe('Too many attempts — try again in 1 minute.');
		expect(loginFailureMessage(429)).toBe('Too many attempts — try again in a few minutes.');
	});

	it('asks for both fields on malformed input', () => {
		expect(loginFailureMessage(422)).toBe('Enter your user and password to sign in.');
		expect(loginFailureMessage(400)).toBe('Enter your user and password to sign in.');
	});

	it('hides backend outages and untrusted-origin errors behind one message', () => {
		for (const status of [403, 500, 503]) {
			expect(loginFailureMessage(status)).toBe(
				'Sign in is unavailable right now. Try again shortly.'
			);
		}
	});
});
