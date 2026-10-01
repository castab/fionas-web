import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from './toast.svelte.js';

describe('toast', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		toast.dismiss();
		vi.useRealTimers();
	});

	it('shows a success then an error toast', () => {
		toast.success('Signed in');
		expect(toast.current).toMatchObject({ message: 'Signed in', tone: 'success' });
		toast.error('Nope');
		expect(toast.current).toMatchObject({ message: 'Nope', tone: 'error' });
	});

	it('changes key on every call so repeats re-animate', () => {
		toast.error('Nope');
		const first = toast.current?.key;
		toast.error('Nope');
		expect(toast.current?.key).not.toBe(first);
	});

	it('auto-dismisses after 3.2s, restarting the timer on a new toast', () => {
		toast.success('a');
		vi.advanceTimersByTime(3000);
		toast.success('b');
		vi.advanceTimersByTime(3000);
		expect(toast.current?.message).toBe('b');
		vi.advanceTimersByTime(200);
		expect(toast.current).toBeNull();
	});
});
