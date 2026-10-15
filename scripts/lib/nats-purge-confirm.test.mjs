import { describe, expect, it, vi } from 'vitest';
import { confirmPurge } from './nats-purge-confirm.mjs';

const run = (answers) => {
	const ask = vi.fn();
	for (const answer of answers) ask.mockResolvedValueOnce(answer);
	const write = vi.fn();
	return {
		ask,
		write,
		result: confirmPurge({ stream: 'FIONAS_INQUIRIES', messages: 7, ask, write })
	};
};

describe('confirmPurge', () => {
	it.each(['y', 'Y', 'yes', ' YES '])(
		'proceeds after %j then the typed stream name',
		async (yes) => {
			const { ask, result } = run([yes, 'FIONAS_INQUIRIES']);
			expect(await result).toBe(true);
			expect(ask).toHaveBeenCalledTimes(2);
		}
	);

	it.each(['', 'n', 'no', 'maybe', 'yep'])('stops at the first question on %j', async (answer) => {
		const { ask, result } = run([answer]);
		expect(await result).toBe(false);
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it.each(['', 'y', 'fionas_inquiries', 'FIONAS_INQUIRIES_X'])(
		'stops when the stream name is %j',
		async (typed) => {
			const { result } = run(['y', typed]);
			expect(await result).toBe(false);
		}
	);

	it('states the amount at risk before asking', async () => {
		const { write, result } = run(['n']);
		await result;
		expect(write.mock.calls[0][0]).toContain('7 event(s)');
		expect(write.mock.calls[0][0]).toContain('FIONAS_INQUIRIES');
	});

	it('propagates cancellation', async () => {
		const ask = vi.fn().mockRejectedValue(new Error('cancelled'));
		await expect(confirmPurge({ stream: 'S', messages: 1, ask, write: vi.fn() })).rejects.toThrow(
			'cancelled'
		);
	});
});
