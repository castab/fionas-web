import type { StaffDashboardItem, StaffDashboardResponse } from './dashboard-contract.js';

export const BUSINESS_TIME_ZONE = 'America/Los_Angeles';
export type StatTone = 'olive' | 'olive-soft' | 'moss' | 'rust';
export type StatTileView = { label: string; count: number; tone: StatTone };
export type RequestCardView = {
	id: string;
	name: string;
	eventDate: string;
	dateMonth: string;
	dateDay: string;
	waitMeta: string;
	estLabel: string;
	urgent: boolean;
};
export type DashboardView = {
	stats: StatTileView[];
	replyGroup: RequestCardView[];
	quoteGroup: RequestCardView[];
	resolutionGroup: RequestCardView[];
	waitingCount: number;
	dateLabel: string;
};

/** Format the projection instant in Fiona's event calendar zone. */
export function formatToday(asOf: string): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: BUSINESS_TIME_ZONE,
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	}).format(new Date(asOf));
}

/** Date-only values use UTC for construction and formatting, regardless of host/browser zone. */
export function dateTile(iso: string): { month: string; day: string } {
	const [year, month, day] = iso.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return {
		month: new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date),
		day: String(day)
	};
}

/** Completed elapsed days in the same snapshot; sub-day attention gets human wording. */
export function waitingAge(attentionSince: string, asOf: string): string {
	const days = Math.max(
		0,
		Math.floor((Date.parse(asOf) - Date.parse(attentionSince)) / 86_400_000)
	);
	if (days === 0) return 'Waiting less than a day';
	return `Waiting ${days} day${days === 1 ? '' : 's'}`;
}

/** Intl accepts exact decimal strings at runtime; the cast bridges TS's narrower signature. */
export function formatMoney(decimal: string, currency: string): string {
	const fraction = (decimal.split('.')[1] ?? '').replace(/0+$/, '');
	const currencyDigits =
		new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency
		}).resolvedOptions().maximumFractionDigits ?? 2;
	const digits = fraction ? Math.max(currencyDigits, fraction.length) : 0;
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency,
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(decimal as unknown as number);
}

export function amountLabel(
	item: Pick<StaffDashboardItem, 'total' | 'totalQualifier' | 'currency'>
): string {
	return `${item.totalQualifier === 'FROM' ? 'from ' : ''}${formatMoney(item.total, item.currency)}`;
}

const eventLabels: Record<StaffDashboardItem['eventType'], string> = {
	BIRTHDAY: 'Birthday party',
	WEDDING: 'Wedding',
	CORPORATE: 'Corporate event',
	SCHOOL_EVENT: 'School event',
	NEIGHBORHOOD_EVENT: 'Neighborhood event',
	OTHER: 'Other event'
};

export function requestCard(
	item: StaffDashboardItem,
	asOf: string,
	urgent = false
): RequestCardView {
	const tile = dateTile(item.eventDate);
	return {
		id: item.inquiryId,
		name: item.customerName,
		eventDate: item.eventDate,
		dateMonth: tile.month,
		dateDay: tile.day,
		waitMeta: `${waitingAge(item.attentionSince, asOf)} · ${eventLabels[item.eventType]}`,
		estLabel: amountLabel(item),
		urgent
	};
}

export function uniqueWaitingCount(workQueue: StaffDashboardResponse['workQueue']): number {
	return new Set(
		Object.values(workQueue).flatMap((queue) => queue.items.map((item) => item.inquiryId))
	).size;
}

/** Presentation only: counts and membership are backend-owned; preserve its order. */
export function dashboardView(response: StaffDashboardResponse): DashboardView {
	const { asOf, summary, workQueue } = response;
	return {
		dateLabel: formatToday(asOf),
		waitingCount: uniqueWaitingCount(workQueue),
		stats: [
			{ label: 'New', count: summary.new, tone: 'olive' },
			{ label: 'Quoted', count: summary.quoted, tone: 'olive-soft' },
			{ label: 'Booked', count: summary.booked, tone: 'moss' },
			{ label: 'Needs closing', count: summary.needsClosing, tone: 'rust' }
		],
		replyGroup: workQueue.needsReply.items.map((item) => requestCard(item, asOf)),
		quoteGroup: workQueue.needsQuote.items.map((item) => requestCard(item, asOf)),
		resolutionGroup: workQueue.needsResolution.items.map((item) => requestCard(item, asOf, true))
	};
}

export function todayLine(dateLabel: string, waitingCount: number): string {
	return `${dateLabel} · ${waitingCount} request${waitingCount === 1 ? '' : 's'} waiting on you`;
}
