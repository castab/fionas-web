import { describe, expect, it } from 'vitest';
import { attemptRefresh } from './attempt-refresh.js';

/** A read whose answers the test releases one at a time, in any order. */
function controlledReads<T>() {
	const pending: { resolve: (value: T) => void; reject: (error: Error) => void }[] = [];
	return {
		read: () =>
			new Promise<T>((resolve, reject) => {
				pending.push({ resolve, reject });
			}),
		pending,
		async settle(index: number, value: T | Error) {
			const entry = pending[index];
			if (value instanceof Error) entry.reject(value);
			else entry.resolve(value);
			await flush();
		}
	};
}
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup() {
	const reads = controlledReads<string>();
	let basis = 'request-1';
	const applied: [string, string][] = [];
	const failures: number[] = [];
	const busy: boolean[] = [];
	const refresh = attemptRefresh<string, string>({
		read: reads.read,
		basis: () => basis,
		apply: (value, b) => applied.push([value, b]),
		busy: (value) => busy.push(value),
		failure: () => failures.push(applied.length)
	});
	return {
		reads,
		refresh,
		applied,
		failures,
		busy,
		setBasis(next: string) {
			basis = next;
		}
	};
}

describe('attemptRefresh', () => {
	it('coalesces a burst of notifications into one read', async () => {
		const { reads, refresh, applied } = setup();
		void refresh.request();
		void refresh.request();
		void refresh.request();
		await flush();
		expect(reads.pending).toHaveLength(1);
		await reads.settle(0, 'EXPIRED');
		expect(applied).toEqual([['EXPIRED', 'request-1']]);
		expect(reads.pending).toHaveLength(1);
	});

	it('keeps a notification that arrives during a read and reads again afterwards', async () => {
		const { reads, refresh, applied, setBasis } = setup();
		void refresh.request();
		await flush();
		setBasis('request-2');
		void refresh.request(); // arrives mid-read
		await reads.settle(0, 'OPEN');
		// Serialized: the second read starts only after the first applied, so it can't be overtaken.
		expect(reads.pending).toHaveLength(2);
		await reads.settle(1, 'PROCESSING');
		expect(applied).toEqual([
			['OPEN', 'request-1'],
			['PROCESSING', 'request-2']
		]);
	});

	it('never lets a read older than a local answer overwrite it, and reads again', async () => {
		const { reads, refresh, applied } = setup();
		void refresh.request();
		await flush();
		refresh.local(); // a reconcile answer applied its own re-listed attempts meanwhile
		await reads.settle(0, 'OPEN (stale)');
		expect(applied).toEqual([]);
		expect(reads.pending).toHaveLength(2);
		await reads.settle(1, 'EXPIRED');
		expect(applied).toEqual([['EXPIRED', 'request-1']]);
	});

	it('reports a failed read without applying anything, and recovers on the next hint', async () => {
		const { reads, refresh, applied, failures, busy } = setup();
		void refresh.request();
		await flush();
		await reads.settle(0, new Error('503'));
		expect(applied).toEqual([]);
		expect(failures).toEqual([0]);
		expect(busy.at(-1)).toBe(false);
		void refresh.request();
		await flush();
		await reads.settle(1, 'EXPIRED');
		expect(applied).toEqual([['EXPIRED', 'request-1']]);
	});

	it('stops after dispose: no late apply, no new reads', async () => {
		const { reads, refresh, applied } = setup();
		void refresh.request();
		await flush();
		refresh.dispose();
		await reads.settle(0, 'EXPIRED');
		expect(applied).toEqual([]);
		expect(await refresh.request()).toBe(false);
		expect(reads.pending).toHaveLength(1);
	});
});
