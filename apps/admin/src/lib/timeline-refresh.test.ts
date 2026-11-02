import { expect, it, vi } from 'vitest';
import { timelineRefresh } from './timeline-refresh.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
it('coalesces bursts and serializes manual/hint requests, retaining hints during a read', async () => {
	const first = deferred<number>();
	const second = deferred<number>();
	const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
	const apply = vi.fn();
	const refresh = timelineRefresh({ read, apply, busy: vi.fn(), failure: vi.fn() });
	const done = refresh.request();
	refresh.request();
	await Promise.resolve();
	expect(read).toHaveBeenCalledTimes(1);
	refresh.request(true);
	refresh.request();
	first.resolve(1);
	await Promise.resolve();
	expect(read).toHaveBeenCalledTimes(2);
	expect(apply).toHaveBeenLastCalledWith(1);
	second.resolve(2);
	expect(await done).toBe(true);
	expect(apply).toHaveBeenLastCalledWith(2);
});
it('preserves data on failure, permits recovery, and ignores disposed results', async () => {
	const read = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValueOnce(2);
	const apply = vi.fn();
	const failure = vi.fn();
	const refresh = timelineRefresh({ read, apply, busy: vi.fn(), failure });
	expect(await refresh.request()).toBe(false);
	expect(apply).not.toHaveBeenCalled();
	expect(failure).toHaveBeenCalledWith(false);
	expect(await refresh.request(true)).toBe(true);
	const pending = deferred<number>();
	read.mockReturnValueOnce(pending.promise);
	const done = refresh.request();
	await Promise.resolve();
	const signal = read.mock.calls.at(-1)![0];
	refresh.dispose();
	pending.resolve(3);
	expect(await done).toBe(false);
	expect(signal.aborted).toBe(true);
	expect(apply).toHaveBeenCalledTimes(1);
});
