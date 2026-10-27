import { describe, expect, it } from 'vitest';
import {
	REQUEST_FILTERS,
	clearSearchSearch,
	emptyListCopy,
	filterSearch,
	firstPageSearch,
	isStaffRequestList,
	listSearch,
	nextPageSearch,
	readListQuery,
	readReturnContext,
	recoverySearch,
	requestFilterLabels,
	requestListErrorKind,
	requestListView,
	requestRow,
	resultCountLabel,
	workspaceAction,
	workspaceRedirect,
	workspaceSearch,
	describeRejectedRequestList,
	type RequestListQuery
} from './request-list.js';
import { dashboardView } from './dashboard.js';
import type { StaffRequestListItem, StaffRequestListResponse } from './request-list-contract.js';
import { dashboardFixture } from '../../e2e/dashboard-fixture.mjs';

const params = (search: string) => new URLSearchParams(search);
const query = (overrides: Partial<RequestListQuery> = {}): RequestListQuery => ({
	filter: 'all',
	q: '',
	cursor: null,
	...overrides
});
const item = (overrides: Partial<StaffRequestListItem> = {}): StaffRequestListItem => ({
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
	latestDocumentVersionAt: '2026-07-11T18:00:00Z',
	...overrides
});
const page = (overrides: Partial<StaffRequestListResponse> = {}): StaffRequestListResponse => ({
	items: [item()],
	totalCount: 1,
	...overrides
});

describe('Requests URL state', () => {
	it('reads every supported filter, with all as the default', () => {
		for (const filter of REQUEST_FILTERS)
			expect(readListQuery(params(`filter=${filter}`))).toEqual({
				query: query({ filter }),
				problem: null
			});
		expect(readListQuery(params(''))).toEqual({ query: query(), problem: null });
		expect(Object.keys(requestFilterLabels)).toEqual([...REQUEST_FILTERS]);
	});
	it('treats an unknown, empty-valued or repeated filter as a problem, keeping the valid parts', () => {
		expect(readListQuery(params('filter=archived&q=maria'))).toEqual({
			query: query({ q: 'maria' }),
			problem: 'filter'
		});
		expect(readListQuery(params('filter=Quoted')).problem).toBe('filter');
		expect(readListQuery(params('filter=')).problem).toBe('filter');
		expect(readListQuery(params('filter=new&filter=quoted')).problem).toBe('filter');
	});
	it('trims the search, ignores blank text and refuses what the API would', () => {
		expect(readListQuery(params('q=%20%20Maria%20')).query.q).toBe('Maria');
		expect(readListQuery(params('q=%20%20'))).toEqual({ query: query(), problem: null });
		expect(readListQuery(params(`q=${'a'.repeat(200)}`)).problem).toBeNull();
		expect(readListQuery(params(`q=${'a'.repeat(201)}`)).problem).toBe('search');
		expect(readListQuery(params('q=ma%00ria')).problem).toBe('search');
		expect(readListQuery(params('q=a&q=b')).problem).toBe('search');
	});
	it('carries an opaque cursor unchanged and only refuses an unusable one', () => {
		const cursor = 'WyJxdW90ZWR8IiwiMjAyNi0wNy0xMFQxOTowMDowMFoiXQ';
		expect(readListQuery(params(`filter=quoted&cursor=${cursor}`)).query.cursor).toBe(cursor);
		// The API refuses an explicitly empty cursor; the first page simply has none.
		expect(readListQuery(params('filter=quoted&q=maria&cursor='))).toEqual({
			query: query({ filter: 'quoted', q: 'maria' }),
			problem: 'cursor'
		});
		expect(readListQuery(params('cursor=a%20b')).problem).toBe('cursor');
		expect(readListQuery(params(`cursor=${'a'.repeat(513)}`)).problem).toBe('cursor');
	});
	it('serializes canonical, encoded list URLs', () => {
		expect(listSearch()).toBe('');
		expect(listSearch(query())).toBe('');
		expect(listSearch(query({ filter: 'needs-closing' }))).toBe('?filter=needs-closing');
		expect(listSearch(query({ filter: 'quoted', q: 'María & co+1@x.com' }))).toBe(
			'?filter=quoted&q=Mar%C3%ADa%20%26%20co%2B1%40x.com'
		);
		const parsed = readListQuery(
			params(
				listSearch(query({ filter: 'quoted', q: 'María & co+1@x.com', cursor: 'a/b=' })).slice(1)
			)
		);
		expect(parsed).toEqual({
			query: query({ filter: 'quoted', q: 'María & co+1@x.com', cursor: 'a/b=' }),
			problem: null
		});
	});
	it('changing filters keeps the search and clears the cursor', () => {
		const current = query({ filter: 'quoted', q: 'maria', cursor: 'next-token' });
		expect(filterSearch(current, 'booked')).toBe('?filter=booked&q=maria');
		expect(filterSearch(current, 'all')).toBe('?q=maria');
		expect(firstPageSearch(current)).toBe('?filter=quoted&q=maria');
		expect(clearSearchSearch(current)).toBe('?filter=quoted');
	});
	it('a new GET search keeps the filter and starts at the first page', () => {
		// The form sends only the hidden filter and q, so a submitted search never carries a cursor.
		expect(readListQuery(params('filter=quoted&q=dan')).query).toEqual(
			query({ filter: 'quoted', q: 'dan' })
		);
	});
	it('pagination carries the backend cursor with the same filter and search', () => {
		expect(nextPageSearch(query({ filter: 'booked', q: 'grant', cursor: 'old' }), 'new+/=')).toBe(
			'?filter=booked&q=grant&cursor=new%2B%2F%3D'
		);
	});
	it('recovers an invalid view to a different, safe view', () => {
		const withCursor = query({ filter: 'quoted', q: 'maria', cursor: 'stale' });
		expect(recoverySearch(withCursor, null)).toEqual({
			reason: 'cursor',
			search: '?filter=quoted&q=maria',
			label: 'Start from the first page'
		});
		expect(recoverySearch(query({ filter: 'quoted', q: 'maria' }), 'cursor').search).toBe(
			'?filter=quoted&q=maria'
		);
		expect(recoverySearch(query({ filter: 'quoted', q: 'maria' }), null)).toMatchObject({
			reason: 'search',
			search: '?filter=quoted'
		});
		expect(recoverySearch(query({ q: 'maria' }), 'filter')).toMatchObject({
			search: '?q=maria',
			label: 'View all requests'
		});
		expect(recoverySearch(query({ filter: 'quoted' }), null).search).toBe('');
	});
	it('maps every dashboard tile to its Requests filter', () => {
		expect(
			dashboardView(dashboardFixture).stats.map((stat) => [stat.label, listSearch(stat)])
		).toEqual([
			['New', '?filter=new'],
			['Quoted', '?filter=quoted'],
			['Booked', '?filter=booked'],
			['Needs closing', '?filter=needs-closing']
		]);
	});
});

describe('workspace return context', () => {
	const context = query({ filter: 'quoted', q: 'maria & co', cursor: 'tok/en+=' });
	const fromUrl = (search: string) => new URL(`https://admin.test/requests/abc${search}`);
	it('round-trips filter, search and cursor through one encoded parameter', () => {
		const search = workspaceSearch(context);
		expect(search).toBe(
			`?from=${encodeURIComponent('filter=quoted&q=maria%20%26%20co&cursor=tok%2Fen%2B%3D')}`
		);
		expect(readReturnContext(fromUrl(search).searchParams)).toEqual(context);
		expect(readReturnContext(fromUrl(workspaceSearch(query())).searchParams)).toEqual(query());
	});
	it('keeps existing panel URLs unchanged without a context and composes them with one', () => {
		expect(workspaceSearch(null)).toBe('');
		expect(workspaceSearch(null, 'quote')).toBe('?quote');
		const search = workspaceSearch(context, 'payment');
		expect(search.startsWith('?payment&from=')).toBe(true);
		const url = fromUrl(search);
		expect(url.searchParams.has('payment')).toBe(true);
		expect(readReturnContext(url.searchParams)).toEqual(context);
	});
	it('composes form actions SvelteKit can route, keeping the panel and context', () => {
		expect(workspaceAction(null, 'declineInquiry')).toBe('?/declineInquiry');
		expect(workspaceAction(null, 'previewQuote', 'quote')).toBe('?quote&/previewQuote');
		const action = workspaceAction(context, 'issueQuote', 'quote');
		const url = fromUrl(action);
		expect([...url.searchParams.keys()]).toEqual(['quote', 'from', '/issueQuote']);
		expect(readReturnContext(url.searchParams)).toEqual(context);
		// PRG goes to the clean workspace path, with only the context.
		expect(workspaceRedirect(url)).toBe(`/requests/abc${workspaceSearch(context)}`);
		expect(workspaceRedirect(fromUrl('?/markServed'))).toBe('/requests/abc');
		expect(workspaceRedirect(fromUrl('?from=https%3A%2F%2Fevil.example&/markServed'))).toBe(
			'/requests/abc'
		);
	});
	it.each([
		['absolute URL', 'https://evil.example/requests'],
		['protocol-relative URL', '//evil.example'],
		['path', '/requests?filter=quoted'],
		['another admin path', '/logout'],
		['unexpected key', 'filter=quoted&next=/logout'],
		['missing filter', 'q=maria'],
		['unknown filter', 'filter=everything'],
		['repeated key', 'filter=quoted&filter=new'],
		['over-long search', `filter=all&q=${'a'.repeat(201)}`],
		['control characters', 'filter=all&q=a%0Ab'],
		['empty cursor', 'filter=quoted&cursor='],
		['empty value', '']
	])('rejects a %s as a return destination', (_name, value) => {
		expect(readReturnContext(params(`from=${encodeURIComponent(value)}`))).toBeNull();
	});
	it('rejects a repeated or over-long from parameter', () => {
		const ok = encodeURIComponent('filter=quoted');
		expect(readReturnContext(params(`from=${ok}`))).toEqual(query({ filter: 'quoted' }));
		expect(readReturnContext(params(`from=${ok}&from=${ok}`))).toBeNull();
		expect(
			readReturnContext(
				params(`from=${encodeURIComponent(`filter=all&cursor=${'a'.repeat(5000)}`)}`)
			)
		).toBeNull();
	});
});

describe('collection validation', () => {
	it('accepts the documented page, with nextCursor omitted, null or present', () => {
		expect(isStaffRequestList(page())).toBe(true);
		expect(isStaffRequestList(page({ nextCursor: null }))).toBe(true);
		expect(isStaffRequestList(page({ nextCursor: 'abc', totalCount: 30 }))).toBe(true);
		expect(isStaffRequestList({ items: [], totalCount: 0 })).toBe(true);
	});
	it.each([
		['missing items', { totalCount: 0 }],
		['items not an array', { items: {}, totalCount: 0 }],
		['negative totalCount', { items: [], totalCount: -1 }],
		['fractional totalCount', { items: [], totalCount: 1.5 }],
		['totalCount below the page', { items: [item()], totalCount: 0 }],
		['empty nextCursor', { items: [], totalCount: 0, nextCursor: '' }],
		['numeric nextCursor', { items: [], totalCount: 0, nextCursor: 4 }],
		['numeric total', { items: [{ ...item(), total: 1240 }], totalCount: 1 }],
		['float-looking total', { items: [{ ...item(), total: '1.2e3' }], totalCount: 1 }],
		['missing balance', { items: [{ ...item(), balance: undefined }], totalCount: 1 }],
		['unknown stage', { items: [{ ...item(), stage: 'ARCHIVED' }], totalCount: 1 }],
		['missing identity', { items: [{ ...item(), inquiryId: '' }], totalCount: 1 }],
		[
			'instant event date',
			{ items: [{ ...item(), eventDate: '2026-09-12T00:00:00Z' }], totalCount: 1 }
		],
		['string needsClosing', { items: [{ ...item(), needsClosing: 'false' }], totalCount: 1 }],
		['unknown qualifier', { items: [{ ...item(), totalQualifier: 'ABOUT' }], totalCount: 1 }],
		['duplicate inquiry', { items: [item(), item()], totalCount: 2 }],
		['null', null]
	])('refuses a page with %s', (_name, value) => {
		expect(isStaffRequestList(value)).toBe(false);
	});
	it('describes refusals without customer values', () => {
		const described = JSON.stringify(
			describeRejectedRequestList({ items: [{ ...item(), total: 1240 }], totalCount: 'many' })
		);
		expect(described).not.toContain('Sofia');
		expect(described).not.toContain('example-events');
		expect(JSON.parse(described)).toEqual({
			itemsIsArray: true,
			itemCount: 1,
			invalidItems: 1,
			totalCount: 'string',
			nextCursor: 'undefined'
		});
	});
	it('maps statuses to safe list states', () => {
		expect([400, 401, 403, 404, 500, 503].map(requestListErrorKind)).toEqual([
			'invalid',
			'unavailable',
			'forbidden',
			'unavailable',
			'unavailable',
			'unavailable'
		]);
	});
});

describe('Requests presentation', () => {
	it('preserves backend order and copies counts and cursors as returned', () => {
		const ids = ['c', 'a', 'b'].map((id) => `00000000-0000-0000-0000-00000000000${id}`);
		const view = requestListView(
			page({
				items: ids.map((inquiryId) => item({ inquiryId })),
				totalCount: 61,
				nextCursor: 'opaque'
			})
		);
		expect(view.rows.map((row) => row.id)).toEqual(ids);
		expect(view).toMatchObject({ totalCount: 61, nextCursor: 'opaque' });
		expect(requestListView(page()).nextCursor).toBeNull();
	});
	it('labels the actual stage, so a Booked result can show Served', () => {
		const served = requestRow(
			item({ stage: 'SERVED', financialStage: 'INVOICE', needsClosing: true, balance: '0.00' })
		);
		expect(served).toMatchObject({
			stageLabel: 'Served',
			stageTone: 'moss',
			needsClosing: true,
			totalCaption: 'Invoice',
			balanceLabel: '$0'
		});
		for (const [stage, label] of [
			['REQUESTED', 'Requested'],
			['QUOTED', 'Quoted'],
			['BOOKED', 'Booked'],
			['CLOSED', 'Closed'],
			['DECLINED', 'Declined']
		] as const)
			expect(requestRow(item({ stage })).stageLabel).toBe(label);
	});
	it('uses needsClosing exactly as returned, never from the balance', () => {
		const row = (needsClosing: boolean, balance: string) =>
			requestRow(item({ stage: 'SERVED', financialStage: 'INVOICE', needsClosing, balance }))
				.needsClosing;
		expect(row(false, '0.00')).toBe(false);
		expect(row(true, '25.00')).toBe(true);
	});
	it('formats exact totals with the FROM qualifier, and only an Invoice balance', () => {
		expect(requestRow(item({ total: '850', totalQualifier: 'EXACT' })).totalLabel).toBe('$850');
		expect(
			requestRow(item({ total: '850.00', totalQualifier: 'FROM', financialStage: 'ESTIMATE' }))
		).toMatchObject({ totalLabel: 'from $850', totalCaption: 'Estimate', balanceLabel: null });
		expect(requestRow(item({ total: '9007199254740993.50' })).totalLabel).toBe(
			'$9,007,199,254,740,993.50'
		);
		expect(requestRow(item({ balance: '1240.00' })).balanceLabel).toBeNull();
		expect(
			requestRow(item({ financialStage: 'INVOICE', stage: 'BOOKED', balance: '-12.50' }))
				.balanceLabel
		).toBe('-$12.50');
		expect(requestRow(item({ stage: 'DECLINED', financialStage: 'ESTIMATE' })).totalCaption).toBe(
			'Declined estimate'
		);
	});
	it('formats date-only events without timezone drift and submission on the business calendar', () => {
		expect(requestRow(item({ eventDate: '2027-01-01' }))).toMatchObject({
			dateMonth: 'Jan',
			dateDay: '1',
			eventLabel: 'Fri, Jan 1, 2027 · Wedding'
		});
		expect(requestRow(item({ inquiryCreatedAt: '2026-07-11T03:30:00Z' })).submittedLabel).toBe(
			'Submitted Jul 10'
		);
	});
	it('words counts, empty filters, empty searches and pages past the end', () => {
		expect(resultCountLabel(1, '')).toBe('1 request');
		expect(resultCountLabel(8, 'maria')).toBe('8 requests matching “maria”');
		expect(emptyListCopy(query())).toEqual({
			message: 'No requests yet. New inquiries will appear here.',
			action: null
		});
		expect(emptyListCopy(query({ filter: 'quoted' }))).toEqual({
			message: 'No quoted requests found.',
			action: { search: '', label: 'View all requests' }
		});
		expect(emptyListCopy(query({ filter: 'quoted', q: 'zed' }))).toEqual({
			message: 'No requests match “zed”.',
			action: { search: '?filter=quoted', label: 'Clear search' }
		});
		expect(emptyListCopy(query({ filter: 'quoted', cursor: 'x' })).action).toEqual({
			search: '?filter=quoted',
			label: 'Start from the first page'
		});
	});
});
