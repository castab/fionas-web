import { describe, expect, it, vi } from 'vitest';
import { getDashboard } from './dashboard.js';
import type { BackendConfig } from './backend.js';
import { dashboardFixture } from '../../../e2e/dashboard-fixture.mjs';

const config = (fetch: BackendConfig['fetch']): BackendConfig => ({
	baseUrl: 'http://api.test',
	origin: 'https://admin.test',
	fetch
});

describe('getDashboard', () => {
	it('makes one GET with the incoming USER cookie and deserializes the complete projection', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(dashboardFixture), {
					headers: { 'content-type': 'application/json', 'set-cookie': 'session=renewed; Path=/' }
				})
		);
		const result = await getDashboard(config(fetch), 'session=staff');
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://api.test/staff/dashboard');
		expect(init.method).toBe('GET');
		expect(init.headers).toEqual({
			accept: 'application/json',
			origin: 'https://admin.test',
			cookie: 'session=staff'
		});
		expect(init.body).toBeUndefined();
		expect(result).toEqual({
			ok: true,
			data: dashboardFixture,
			setCookies: ['session=renewed; Path=/']
		});
		if (result.ok) expect(result.data.workQueue.needsQuote.items[1].totalQualifier).toBe('FROM');
	});
	it.each([401, 403, 500, 503])(
		'preserves a backend %i failure without retrying or fabricating counts',
		async (status) => {
			const fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ code: 'failure', message: 'private diagnostic' }), {
						status
					})
			);
			const result = await getDashboard(config(fetch), 'session=staff');
			expect(fetch).toHaveBeenCalledOnce();
			expect(result).toMatchObject({ ok: false, error: { status, code: 'failure' } });
			expect(result).not.toHaveProperty('data');
		}
	);
	it('returns unavailable for network failures', async () => {
		const result = await getDashboard(
			config(async () => {
				throw new TypeError('unreachable');
			}),
			'session=staff'
		);
		expect(result).toMatchObject({ ok: false, error: { status: 503, code: 'unavailable' } });
	});
});
