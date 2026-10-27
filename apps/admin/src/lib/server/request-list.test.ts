import { describe, expect, it, vi } from 'vitest';
import { getStaffRequests } from './request-list.js';
import type { BackendConfig } from './backend.js';
import type { RequestListQuery } from '../request-list.js';

const config = (fetch: BackendConfig['fetch']): BackendConfig => ({
	baseUrl: 'http://api.test/',
	origin: 'https://admin.test',
	fetch
});
const query = (overrides: Partial<RequestListQuery> = {}): RequestListQuery => ({
	filter: 'all',
	q: '',
	cursor: null,
	...overrides
});
const finalPage = {
	items: [
		{
			inquiryId: '00000000-0000-0000-0000-000000000006',
			customerId: '00000000-0000-0000-0000-000000000006',
			customerName: 'Sofia Ramirez-Delacruz',
			customerEmail: 'sofia@example-events.com',
			eventDate: '2026-09-12',
			eventType: 'WEDDING',
			stage: 'QUOTED',
			needsClosing: false,
			documentId: '10000000-0000-0000-0000-000000000006',
			version: 2,
			financialStage: 'QUOTE',
			total: '1240.00',
			totalQualifier: 'EXACT',
			balance: '1240.00',
			currency: 'USD',
			inquiryCreatedAt: '2026-07-10T19:00:00Z',
			latestDocumentVersionAt: '2026-07-11T18:00:00Z'
		}
	],
	totalCount: 1
};

describe('getStaffRequests', () => {
	it('makes one bodyless GET with the USER cookie, Origin and encoded query', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(finalPage), {
					headers: { 'content-type': 'application/json', 'set-cookie': 'session=renewed; Path=/' }
				})
		);
		const result = await getStaffRequests(
			config(fetch),
			query({ filter: 'needs-closing', q: 'María & co+1', cursor: 'tok/en+=' }),
			'session=staff'
		);
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(
			'http://api.test/staff/requests?filter=needs-closing&q=Mar%C3%ADa%20%26%20co%2B1&cursor=tok%2Fen%2B%3D'
		);
		expect(new URL(url).searchParams.get('q')).toBe('María & co+1');
		expect(init.method).toBe('GET');
		expect(init.body).toBeUndefined();
		expect(init.headers).toEqual({
			accept: 'application/json',
			origin: 'https://admin.test',
			cookie: 'session=staff'
		});
		// The final page omits nextCursor; it is passed through as returned.
		expect(result).toEqual({ ok: true, data: finalPage, setCookies: ['session=renewed; Path=/'] });
		if (result.ok) expect('nextCursor' in result.data).toBe(false);
	});
	it('sends all explicitly, omits a blank search and the first page cursor, and leaves the page size to the API', async () => {
		const fetch = vi.fn(async () => Response.json({ items: [], totalCount: 0 }));
		await getStaffRequests(config(fetch), query(), null);
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://api.test/staff/requests?filter=all');
		expect(init.headers).not.toHaveProperty('cookie');
	});
	it.each([400, 401, 403, 500, 503])(
		'preserves a backend %i failure without retrying or fabricating results',
		async (status) => {
			const fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ code: 'failure', message: 'private diagnostic' }), {
						status
					})
			);
			const result = await getStaffRequests(config(fetch), query({ filter: 'quoted' }), 'c=1');
			expect(fetch).toHaveBeenCalledOnce();
			expect(result).toMatchObject({ ok: false, error: { status, code: 'failure' } });
			expect(result).not.toHaveProperty('data');
		}
	);
	it('returns unavailable for network failures, once', async () => {
		const fetch = vi.fn(async () => {
			throw new TypeError('unreachable');
		});
		const result = await getStaffRequests(config(fetch), query(), 'c=1');
		expect(fetch).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ ok: false, error: { status: 503, code: 'unavailable' } });
	});
});
