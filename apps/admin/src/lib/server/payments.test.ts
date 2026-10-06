import { describe, expect, it, vi } from 'vitest';
import { recordPayment } from './staff-request.js';

describe('payment server client', () => {
	it.each([true, false])(
		'forwards the exact command and USER cookie; deposit=%s',
		async (deposit) => {
			const fetch = vi.fn(
				async () =>
					new Response('{}', { status: 201, headers: { 'set-cookie': 'session=renewed; Path=/' } })
			);
			const json = {
				documentVersion: 2,
				amount: '300.00',
				method: 'CASH',
				...(deposit ? { expectedProposalId: 'reviewed-proposal' } : {})
			};
			const result = await recordPayment(
				{ baseUrl: 'http://api.test', origin: 'https://admin.test', fetch },
				'document/id',
				json,
				'session=staff'
			);
			expect(fetch).toHaveBeenCalledExactlyOnceWith(
				'http://api.test/financial-documents/document%2Fid/payments',
				expect.objectContaining({
					method: 'POST',
					body: JSON.stringify(json),
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
						origin: 'https://admin.test',
						cookie: 'session=staff'
					}
				})
			);
			expect(result).toMatchObject({ ok: true, setCookies: ['session=renewed; Path=/'] });
		}
	);
	it.each([401, 403, 404, 409, 422, 500, 503])(
		'never retries %i, including ambiguous post-commit errors',
		async (status) => {
			const fetch = vi.fn(async () => new Response('{"message":"PRIVATE"}', { status }));
			expect(
				await recordPayment(
					{ baseUrl: 'http://api.test', origin: 'http://admin.test', fetch },
					'id',
					{ documentVersion: 3, amount: '100.00', method: 'OTHER' },
					'session=staff'
				)
			).toMatchObject({ ok: false, error: { status } });
			expect(fetch).toHaveBeenCalledOnce();
		}
	);
	it('does not retry network failure', async () => {
		const fetch = vi.fn(async () => {
			throw new TypeError('network');
		});
		expect(
			await recordPayment(
				{ baseUrl: 'http://api.test', origin: 'http://admin.test', fetch },
				'id',
				{ documentVersion: 3, amount: '100.00', method: 'CASH' },
				null
			)
		).toMatchObject({ ok: false, error: { status: 503 } });
		expect(fetch).toHaveBeenCalledOnce();
	});
});
