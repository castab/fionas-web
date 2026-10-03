/**
 * The dashboard's display math, ported from the "Admin Console v4" design. Pure and client-safe:
 * the route's `load` fills the inputs, the components only render the views.
 * What the API can and can't supply today is in docs/admin-dashboard-report.md.
 */

/** Fiona's runs in Fresno; "today" and wait times are counted on its calendar. */
export const BUSINESS_TIME_ZONE = 'America/Los_Angeles';

export type StatTone = 'olive' | 'olive-soft' | 'moss' | 'rust';

export type StatTileView = { label: string; count: number; tone: StatTone };

export type RequestCardInput = {
	id: string;
	name: string;
	/** Event calendar date, `YYYY-MM-DD`. */
	eventDate: string;
	eventTypeLabel: string;
	/** The calendar date the request has been waiting on staff since, `YYYY-MM-DD`. */
	waitingSince: string;
	/** Exact decimal total of the current estimate or quote; `null` when there is none. */
	estimateTotal: string | null;
	/** The guest count is a lower bound, so the total is a "from" price. */
	estimateIsMinimum: boolean;
};

export type RequestCardView = {
	id: string;
	name: string;
	dateMonth: string;
	dateDay: string;
	waitDays: number;
	waitMeta: string;
	estLabel: string | null;
	/** Needs-resolution cards wear the rust date tile. */
	urgent: boolean;
};

export type DashboardView = {
	stats: StatTileView[];
	replyGroup: RequestCardView[];
	quoteGroup: RequestCardView[];
	resolutionGroup: RequestCardView[];
	/** Requests needing a reply or a quote, for the today line. */
	waitingCount: number;
};

function calendarParts(iso: string): [number, number, number] {
	const [y, m, d] = iso.split('-').map(Number);
	return [y, m, d];
}

/** A calendar date as a UTC instant, so day math never crosses a DST or zone boundary. */
function utcDate(iso: string): Date {
	const [y, m, d] = calendarParts(iso);
	return new Date(Date.UTC(y, m - 1, d));
}

/** Today's calendar date in the business time zone, `YYYY-MM-DD`. */
export function todayIso(now: Date): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: BUSINESS_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(now);
}

/** "Thursday, July 16" in the business time zone. */
export function formatToday(now: Date): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: BUSINESS_TIME_ZONE,
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	}).format(now);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
	return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000);
}

export function waitLabel(days: number): string {
	if (days === 0) return 'Came in today';
	if (days === 1) return 'Waiting 1 day';
	return `Waiting ${days} days`;
}

/** The card's month/day tile: `{ month: 'Jul', day: '25' }`. */
export function dateTile(iso: string): { month: string; day: string } {
	const date = utcDate(iso);
	return {
		month: date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
		day: String(date.getUTCDate())
	};
}

/**
 * `$1,234` / `$1,234.50` from an exact decimal string, without float arithmetic. Whole amounts drop
 * their cents, as in the design.
 */
export function formatMoney(decimal: string): string {
	const trimmed = decimal.trim();
	const negative = trimmed.startsWith('-');
	const [whole, fraction = ''] = trimmed.replace(/^[-+]/, '').split('.');
	const grouped = (whole.replace(/^0+(?=\d)/, '') || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	const cents = fraction.replace(/0+$/, '');
	return `${negative ? '-' : ''}$${grouped}${cents ? `.${cents.padEnd(2, '0')}` : ''}`;
}

export function estimateLabel(total: string | null, isMinimum: boolean): string | null {
	if (total === null) return null;
	return `${isMinimum ? 'from ' : ''}${formatMoney(total)}`;
}

export function requestCard(
	input: RequestCardInput,
	today: string,
	{ urgent = false }: { urgent?: boolean } = {}
): RequestCardView {
	const tile = dateTile(input.eventDate);
	const waitDays = Math.max(0, daysBetween(input.waitingSince, today));
	return {
		id: input.id,
		name: input.name,
		dateMonth: tile.month,
		dateDay: tile.day,
		waitDays,
		waitMeta: `${waitLabel(waitDays)} · ${input.eventTypeLabel}`,
		estLabel: estimateLabel(input.estimateTotal, input.estimateIsMinimum),
		urgent
	};
}

/** One dashboard group: longest-waiting first, since the wait is what the card shows. */
export function buildGroup(
	inputs: RequestCardInput[],
	today: string,
	options: { urgent?: boolean } = {}
): RequestCardView[] {
	return inputs
		.map((input) => requestCard(input, today, options))
		.sort((a, b) => b.waitDays - a.waitDays);
}

/** "Thursday, July 16 · 3 requests waiting on you"; just the date while the count is unknown. */
export function todayLine(dateLabel: string, waitingCount: number | null): string {
	if (waitingCount === null) return dateLabel;
	return `${dateLabel} · ${waitingCount} request${waitingCount === 1 ? '' : 's'} waiting on you`;
}
