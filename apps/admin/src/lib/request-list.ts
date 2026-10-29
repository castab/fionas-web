import type { StaffRequestListItem, StaffRequestListResponse } from './request-list-contract.js';
import type { InquiryStage } from './request-contract.js';
import { amountLabel } from './dashboard.js';
import {
	dateTile,
	eventDateShortLabel,
	eventTypeLabel,
	formatMoney,
	submittedDateLabel
} from './presentation.js';
import { financialStageLabel, lifecycleLabel, lifecycleTone } from './request-workspace.js';

/**
 * The Requests index (`/requests`). The URL is the only state: filter, search and the opaque cursor
 * live in its query, so every view is bookmarkable, reloadable and native-history friendly. The
 * backend owns membership, search, order, counts and pagination; nothing here re-derives them.
 */
export const REQUEST_FILTERS = [
	'all',
	'new',
	'quoted',
	'booked',
	'needs-closing',
	'closed',
	'declined'
] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number];

export const requestFilterLabels: Record<RequestFilter, string> = {
	all: 'All requests',
	new: 'New',
	quoted: 'Quoted',
	booked: 'Booked',
	'needs-closing': 'Needs closing',
	closed: 'Closed',
	declined: 'Declined'
};

/** The API's limit, counted before trimming. */
export const SEARCH_MAX_LENGTH = 200;
/** A generous bound on an opaque cursor; anything else is the backend's to judge. */
const CURSOR_MAX_LENGTH = 512;

export type RequestListQuery = {
	filter: RequestFilter;
	/** Trimmed search text; empty means no search. */
	q: string;
	/** The opaque continuation that produced this page; null on the first page. */
	cursor: string | null;
};
export type RequestListProblem = 'filter' | 'search' | 'cursor';

const LIST_PARAMS = ['filter', 'q', 'cursor'] as const;
const CONTROL = /\p{Cc}/u;

function isRequestFilter(value: unknown): value is RequestFilter {
	return (REQUEST_FILTERS as readonly unknown[]).includes(value);
}

/**
 * Read the list state from a URL. An unknown filter, an over-long or control-laden search, a
 * malformed cursor or a repeated parameter is a problem to recover from, never silently replaced
 * by another view. The returned query keeps only the parts that are valid, for recovery links.
 */
export function readListQuery(params: URLSearchParams): {
	query: RequestListQuery;
	problem: RequestListProblem | null;
} {
	let problem: RequestListProblem | null = null;
	const one = (name: (typeof LIST_PARAMS)[number], kind: RequestListProblem) => {
		const values = params.getAll(name);
		if (values.length > 1) problem ??= kind;
		return values.length === 1 ? values[0] : null;
	};
	const rawFilter = one('filter', 'filter');
	const rawSearch = one('q', 'search');
	const rawCursor = one('cursor', 'cursor');
	let filter: RequestFilter = 'all';
	if (rawFilter !== null) {
		if (isRequestFilter(rawFilter)) filter = rawFilter;
		else problem ??= 'filter';
	}
	let q = '';
	if (rawSearch !== null) {
		const trimmed = rawSearch.trim();
		if (rawSearch.length > SEARCH_MAX_LENGTH || CONTROL.test(trimmed)) problem ??= 'search';
		else q = trimmed;
	}
	let cursor: string | null = null;
	// Like the API, an explicitly empty `cursor=` is malformed, not the first page (which has none).
	if (rawCursor !== null) {
		if (rawCursor === '' || rawCursor.length > CURSOR_MAX_LENGTH || /[\s\p{Cc}]/u.test(rawCursor))
			problem ??= 'cursor';
		else cursor = rawCursor;
	}
	return { query: { filter, q, cursor }, problem };
}

/** The canonical `/requests` query string (`?…` or empty): `all`, a blank search and page one are implicit. */
export function listSearch({
	filter = 'all',
	q = '',
	cursor = null
}: Partial<RequestListQuery> = {}): string {
	const parts: string[] = [];
	if (filter !== 'all') parts.push(`filter=${encodeURIComponent(filter)}`);
	if (q) parts.push(`q=${encodeURIComponent(q)}`);
	if (cursor) parts.push(`cursor=${encodeURIComponent(cursor)}`);
	return parts.length ? `?${parts.join('&')}` : '';
}

/** Another filter keeps the search and starts again at the first page. */
export function filterSearch(query: RequestListQuery, filter: RequestFilter): string {
	return listSearch({ filter, q: query.q });
}

/** The backend's cursor, carried unchanged with the same filter and search. */
export function nextPageSearch(query: RequestListQuery, nextCursor: string): string {
	return listSearch({ filter: query.filter, q: query.q, cursor: nextCursor });
}

export function firstPageSearch(query: RequestListQuery): string {
	return listSearch({ filter: query.filter, q: query.q });
}

export function clearSearchSearch(query: RequestListQuery): string {
	return listSearch({ filter: query.filter });
}

/**
 * Where an invalid view recovers to, never the URL that failed. A stale or malformed cursor
 * restarts at the first page with the same filter and search; an unusable search is cleared; an
 * unknown filter shows every request, keeping the search. A backend 400 names no field, so its
 * reason is inferred from what the request carried, cursor first.
 */
export function recoverySearch(
	query: RequestListQuery,
	problem: RequestListProblem | null
): { reason: RequestListProblem; search: string; label: string } {
	const reason = problem ?? (query.cursor ? 'cursor' : query.q ? 'search' : 'filter');
	if (reason === 'cursor')
		return { reason, search: firstPageSearch(query), label: 'Start from the first page' };
	if (reason === 'search')
		return { reason, search: clearSearchSearch(query), label: 'Clear search' };
	return { reason, search: listSearch({ q: query.q }), label: 'View all requests' };
}

const invalidCopy: Record<RequestListProblem, string> = {
	cursor:
		'This page of results is no longer available. Start again from the first page; your filter and search are kept.',
	search: `This search couldn’t be used. Search with up to ${SEARCH_MAX_LENGTH} characters of a name, email or request ID.`,
	filter: 'This filter isn’t available. Choose one of the filters above.'
};
export function invalidListMessage(reason: RequestListProblem): string {
	return invalidCopy[reason];
}

/*
 * Return context. A workspace opened from the index carries `from`: the list's own query (filter,
 * search, cursor), encoded once. Only that query is ever accepted, never a path or URL, and the
 * Back link is rebuilt from the parsed values, so it can only lead back to `/requests`.
 */
export const RETURN_PARAM = 'from';
const RETURN_MAX_LENGTH = 4096;

function returnValue(query: RequestListQuery): string {
	return `filter=${encodeURIComponent(query.filter)}${listSearch({ q: query.q, cursor: query.cursor }).replace('?', '&')}`;
}

/** A valid Requests return context from a workspace URL, or null (then Back goes to the dashboard). */
export function readReturnContext(params: URLSearchParams): RequestListQuery | null {
	const values = params.getAll(RETURN_PARAM);
	if (values.length !== 1 || !values[0] || values[0].length > RETURN_MAX_LENGTH) return null;
	let inner: URLSearchParams;
	try {
		inner = new URLSearchParams(values[0]);
	} catch {
		return null;
	}
	const keys = [...inner.keys()];
	if (!inner.has('filter') || keys.some((key) => !(LIST_PARAMS as readonly string[]).includes(key)))
		return null;
	const { query, problem } = readListQuery(inner);
	return problem ? null : query;
}

/**
 * The workspace panels opened by a plain link (`?quote`, `?quote-revision`, `?invoice-revision`,
 * `?payment`, `?decline`, `?history`). Each is a bare flag, so reloads, Back and no-JavaScript work.
 */
export type WorkspacePanel =
	'quote' | 'quote-revision' | 'invoice-revision' | 'payment' | 'decline' | 'history';

/**
 * A workspace query string: an optional panel flag, then the return context. Without either it is
 * empty, so existing `/requests/{id}` and `?quote` URLs are unchanged.
 */
export function workspaceSearch(context: RequestListQuery | null, panel?: WorkspacePanel): string {
	const parts: string[] = [];
	if (panel) parts.push(panel);
	if (context) parts.push(`${RETURN_PARAM}=${encodeURIComponent(returnValue(context))}`);
	return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * A form action that keeps the panel flag and return context, so a failed native POST re-renders
 * in place and a success redirects back with them: `?/declineInquiry`, `?quote&from=…&/issueQuote`.
 */
export function workspaceAction(
	context: RequestListQuery | null,
	action: string,
	panel?: WorkspacePanel
): string {
	const search = workspaceSearch(context, panel);
	return search ? `${search}&/${action}` : `?/${action}`;
}

/** Post/Redirect/Get target after a workspace mutation: the clean path plus any return context. */
export function workspaceRedirect(url: URL): string {
	return `${url.pathname}${workspaceSearch(readReturnContext(url.searchParams))}`;
}

/*
 * Response validation: structure only. Membership, needsClosing, totals and balances are the
 * backend's; a malformed page is unavailable, never empty results or a zero balance.
 */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const EVENT_TYPES = [
	'BIRTHDAY',
	'WEDDING',
	'CORPORATE',
	'SCHOOL_EVENT',
	'NEIGHBORHOOD_EVENT',
	'OTHER'
] as const;
const STAGES: readonly InquiryStage[] = [
	'REQUESTED',
	'QUOTED',
	'BOOKED',
	'SERVED',
	'CLOSED',
	'DECLINED'
];
const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
const instant = (value: unknown) =>
	typeof value === 'string' &&
	/^\d{4}-\d\d-\d\dT/.test(value) &&
	Number.isFinite(Date.parse(value));

export function isStaffRequestListItem(value: unknown): value is StaffRequestListItem {
	if (!value || typeof value !== 'object') return false;
	const item = value as Record<string, unknown>;
	return (
		text(item.inquiryId) &&
		text(item.customerId) &&
		text(item.documentId) &&
		text(item.customerName) &&
		typeof item.customerEmail === 'string' &&
		typeof item.eventDate === 'string' &&
		/^\d{4}-\d\d-\d\d$/.test(item.eventDate) &&
		(EVENT_TYPES as readonly unknown[]).includes(item.eventType) &&
		STAGES.includes(item.stage as InquiryStage) &&
		typeof item.needsClosing === 'boolean' &&
		(item.needsReply === undefined || typeof item.needsReply === 'boolean') &&
		(item.awaitingReplySince == null || instant(item.awaitingReplySince)) &&
		Number.isInteger(item.version) &&
		(item.version as number) > 0 &&
		typeof item.financialStage === 'string' &&
		typeof item.total === 'string' &&
		DECIMAL.test(item.total) &&
		(item.totalQualifier === 'EXACT' || item.totalQualifier === 'FROM') &&
		typeof item.balance === 'string' &&
		DECIMAL.test(item.balance) &&
		typeof item.currency === 'string' &&
		/^[A-Z]{3}$/.test(item.currency) &&
		instant(item.inquiryCreatedAt) &&
		instant(item.latestDocumentVersionAt)
	);
}

export function isStaffRequestList(value: unknown): value is StaffRequestListResponse {
	if (!value || typeof value !== 'object') return false;
	const data = value as Record<string, unknown>;
	const items = data.items;
	return (
		Array.isArray(items) &&
		items.every(isStaffRequestListItem) &&
		new Set(items.map((item) => item.inquiryId)).size === items.length &&
		Number.isInteger(data.totalCount) &&
		(data.totalCount as number) >= items.length &&
		(data.nextCursor === undefined ||
			data.nextCursor === null ||
			(typeof data.nextCursor === 'string' && data.nextCursor !== ''))
	);
}

/** Operator diagnostics for a refused page: shapes and counts only, never customer values. */
export function describeRejectedRequestList(value: unknown) {
	if (!value || typeof value !== 'object')
		return { response: value === null ? 'null' : typeof value };
	const data = value as Record<string, unknown>;
	const items = Array.isArray(data.items) ? data.items : null;
	return {
		itemsIsArray: !!items,
		itemCount: items?.length ?? null,
		invalidItems: items ? items.filter((item) => !isStaffRequestListItem(item)).length : null,
		totalCount: Number.isInteger(data.totalCount) ? data.totalCount : typeof data.totalCount,
		nextCursor: data.nextCursor === null ? 'null' : typeof data.nextCursor
	};
}

export type RequestListError = 'invalid' | 'forbidden' | 'unavailable';
export function requestListErrorKind(status: number): RequestListError {
	return status === 400 ? 'invalid' : status === 403 ? 'forbidden' : 'unavailable';
}

/* Presentation: authoritative values, formatted. Backend order is preserved. */
export type RequestRowView = {
	id: string;
	name: string;
	email: string;
	eventDate: string;
	dateMonth: string;
	dateDay: string;
	eventLabel: string;
	submittedLabel: string;
	stage: InquiryStage;
	stageLabel: string;
	stageTone: ReturnType<typeof lifecycleTone>;
	needsClosing: boolean;
	needsReply?: boolean;
	totalCaption: string;
	totalLabel: string;
	/** Only an Invoice's balance is shown: an Estimate or Quote balance is not money owed yet. */
	balanceLabel: string | null;
};
export type RequestListView = {
	rows: RequestRowView[];
	totalCount: number;
	nextCursor: string | null;
};

export function requestRow(item: StaffRequestListItem): RequestRowView {
	const tile = dateTile(item.eventDate);
	return {
		id: item.inquiryId,
		name: item.customerName,
		email: item.customerEmail,
		eventDate: item.eventDate,
		dateMonth: tile.month,
		dateDay: tile.day,
		eventLabel: `${eventDateShortLabel(item.eventDate)} · ${eventTypeLabel(item.eventType)}`,
		submittedLabel: `Submitted ${submittedDateLabel(item.inquiryCreatedAt)}`,
		stage: item.stage,
		stageLabel: lifecycleLabel(item.stage),
		stageTone: lifecycleTone(item.stage),
		needsClosing: item.needsClosing,
		needsReply: item.needsReply,
		totalCaption:
			item.stage === 'DECLINED' ? 'Declined estimate' : financialStageLabel(item.financialStage),
		totalLabel: amountLabel(item),
		balanceLabel:
			item.financialStage === 'INVOICE' ? formatMoney(item.balance, item.currency) : null
	};
}

export function requestListView(response: StaffRequestListResponse): RequestListView {
	return {
		rows: response.items.map(requestRow),
		totalCount: response.totalCount,
		nextCursor: response.nextCursor ?? null
	};
}

export function resultCountLabel(totalCount: number, q: string): string {
	const count = `${totalCount} request${totalCount === 1 ? '' : 's'}`;
	return q ? `${count} matching “${q}”` : count;
}

const emptyFilterCopy: Record<Exclude<RequestFilter, 'all'>, string> = {
	new: 'No new requests found.',
	quoted: 'No quoted requests found.',
	booked: 'No booked requests found.',
	'needs-closing': 'No requests need closing.',
	closed: 'No closed requests found.',
	declined: 'No declined requests found.'
};

/** Copy for a successful page with no rows. `action` names the one recovery link, if any. */
export function emptyListCopy(query: RequestListQuery): {
	message: string;
	action: { search: string; label: string } | null;
} {
	if (query.cursor)
		return {
			message: 'There are no more results here. The list may have changed since the last page.',
			action: { search: firstPageSearch(query), label: 'Start from the first page' }
		};
	if (query.q)
		return {
			message: `No requests match “${query.q}”.`,
			action: { search: clearSearchSearch(query), label: 'Clear search' }
		};
	if (query.filter === 'all')
		return { message: 'No requests yet. New inquiries will appear here.', action: null };
	return {
		message: emptyFilterCopy[query.filter],
		action: { search: '', label: 'View all requests' }
	};
}
