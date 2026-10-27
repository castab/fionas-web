import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStaffRequests } from '$lib/server/request-list.js';
vi.mock('$lib/server/request-list.js', () => ({ getStaffRequests: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
	backendConfig: () => ({ baseUrl: 'http://api.test', origin: 'https://admin.test' })
}));
import { load } from '../../routes/(app)/requests/+page.server.js';

const item = {
	inquiryId: '00000000-0000-0000-0000-000000000005',
	customerId: '00000000-0000-0000-0000-000000000005',
	customerName: 'Priya Nathan',
	customerEmail: 'priya.nathan@example.com',
	eventDate: '2026-06-30',
	eventType: 'OTHER',
	stage: 'SERVED',
	needsClosing: true,
	documentId: '10000000-0000-0000-0000-000000000005',
	version: 3,
	financialStage: 'INVOICE',
	total: '492.50',
	totalQualifier: 'EXACT',
	balance: '0.00',
	currency: 'USD',
	inquiryCreatedAt: '2026-07-01T19:00:00Z',
	latestDocumentVersionAt: '2026-07-01T19:00:00Z'
} as const;

function event(search = '') {
	return {
		url: new URL(`https://admin.test/requests${search}`),
		request: new Request(`https://admin.test/requests${search}`, {
			headers: { cookie: '__Host-fionas_session=staff' }
		}),
		cookies: { set: vi.fn() },
		setHeaders: vi.fn()
	};
}
const run = (e: ReturnType<typeof event>) =>
	load(e as never) as Promise<Exclude<Awaited<ReturnType<typeof load>>, void>>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.mocked(getStaffRequests).mockResolvedValue({
		ok: true,
		data: { items: [item], totalCount: 3, nextCursor: 'next-page' },
		setCookies: ['__Host-fionas_session="renewed"; Path=/; HttpOnly; Secure']
	});
});

describe('Requests index load', () => {
	it('reads one page as the USER, with no-store and renewed cookies re-issued', async () => {
		const e = event('?filter=booked&q=%20priya%20&cursor=abc');
		const result = await run(e);
		expect(e.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
		expect(getStaffRequests).toHaveBeenCalledOnce();
		const [, query, cookie] = vi.mocked(getStaffRequests).mock.calls[0];
		expect(query).toEqual({ filter: 'booked', q: 'priya', cursor: 'abc' });
		expect(cookie).toBe('__Host-fionas_session=staff');
		expect(e.cookies.set).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			query: { filter: 'booked', q: 'priya', cursor: 'abc' },
			listError: null,
			list: { totalCount: 3, nextCursor: 'next-page' }
		});
		// A Booked result keeps its actual stage.
		expect(result.list?.rows[0]).toMatchObject({ stageLabel: 'Served', needsClosing: true });
	});
	it('presents a successful empty page as results, not a failure', async () => {
		vi.mocked(getStaffRequests).mockResolvedValue({
			ok: true,
			data: { items: [], totalCount: 0 },
			setCookies: []
		});
		const result = await run(event('?filter=closed'));
		expect(result).toMatchObject({
			listError: null,
			list: { rows: [], totalCount: 0, nextCursor: null }
		});
	});
	it.each([
		['?filter=everything', 'filter', ''],
		[`?filter=quoted&q=${'a'.repeat(201)}`, 'search', '?filter=quoted'],
		['?filter=quoted&q=maria&cursor=has%20space', 'cursor', '?filter=quoted&q=maria'],
		['?filter=quoted&q=maria&cursor=', 'cursor', '?filter=quoted&q=maria'],
		['?filter=new&filter=quoted', 'filter', '']
	])('recovers %s locally, without a backend read', async (search, reason, recovery) => {
		const result = await run(event(search));
		expect(getStaffRequests).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			list: null,
			listError: 'invalid',
			recovery: { reason, search: recovery }
		});
	});
	it('treats a backend 400 for a cursor as a restart at the first page, keeping filter and search', async () => {
		vi.mocked(getStaffRequests).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status: 400, code: 'malformed_request', message: 'PRIVATE', violations: [] }
		});
		const result = await run(event('?filter=quoted&q=maria&cursor=stale'));
		expect(result).toMatchObject({
			list: null,
			listError: 'invalid',
			recovery: {
				reason: 'cursor',
				search: '?filter=quoted&q=maria',
				label: 'Start from the first page'
			}
		});
		expect(JSON.stringify(result)).not.toContain('PRIVATE');
	});
	it.each([
		[403, 'forbidden'],
		[404, 'unavailable'],
		[500, 'unavailable'],
		[503, 'unavailable']
	])('maps %i to %s without results, counts or diagnostics', async (status, listError) => {
		vi.mocked(getStaffRequests).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status, code: 'failure', message: 'PRIVATE diagnostic', violations: [] }
		});
		const result = await run(event('?filter=quoted'));
		expect(getStaffRequests).toHaveBeenCalledOnce();
		expect(result).toEqual({
			query: { filter: 'quoted', q: '', cursor: null },
			list: null,
			listError,
			recovery: null
		});
		expect(vi.mocked(console.error).mock.calls.join(' ')).not.toContain('PRIVATE');
	});
	it('sends a 401 to sign in', async () => {
		vi.mocked(getStaffRequests).mockResolvedValue({
			ok: false,
			retryAfter: null,
			error: { status: 401, code: 'unauthenticated', message: '', violations: [] }
		});
		await expect(run(event())).rejects.toMatchObject({ status: 303, location: '/login' });
	});
	it('refuses a malformed page as unavailable and logs only its shape', async () => {
		vi.mocked(getStaffRequests).mockResolvedValue({
			ok: true,
			data: { items: [{ ...item, balance: 0 }], totalCount: 1 } as never,
			setCookies: []
		});
		const result = await run(event('?q=priya'));
		expect(result).toMatchObject({ list: null, listError: 'unavailable' });
		const logged = vi.mocked(console.error).mock.calls.join(' ');
		expect(logged).toContain('invalidItems');
		expect(logged).not.toContain('Priya');
		expect(logged).not.toContain('priya');
	});
});
