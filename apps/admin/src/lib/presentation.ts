import type { StaffDashboardItem } from './dashboard-contract.js';

export const BUSINESS_TIME_ZONE = 'America/Los_Angeles';

/** Date-only values never go through the host's or browser's local timezone. */
function calendarDate(iso: string): Date {
	const [year, month, day] = iso.split('-').map(Number);
	return new Date(Date.UTC(year, month - 1, day));
}

export function dateTile(iso: string): { month: string; day: string } {
	return {
		month: new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(
			calendarDate(iso)
		),
		day: String(Number(iso.split('-')[2]))
	};
}

export function eventDateLabel(iso: string): string {
	return new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC'
	}).format(calendarDate(iso));
}

/** "Sat, Jul 25, 2026": compact enough for a list row, with the year for history. */
export function eventDateShortLabel(iso: string): string {
	return new Intl.DateTimeFormat('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(calendarDate(iso));
}

/** Today's calendar date (YYYY-MM-DD) in the business timezone. */
export function businessDate(now: Date): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: BUSINESS_TIME_ZONE
	}).formatToParts(now);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Whole calendar days from `today` to the event; negative once the date has passed. */
export function daysUntil(eventDate: string, today: string): number {
	return Math.round(
		(calendarDate(eventDate).getTime() - calendarDate(today).getTime()) / 86_400_000
	);
}

/** "today", "tomorrow" or "in N days"; null once the event date has passed. */
export function countdownLabel(days: number): string | null {
	if (days < 0) return null;
	if (days === 0) return 'today';
	if (days === 1) return 'tomorrow';
	return `in ${days} days`;
}

export function submittedDateLabel(instant: string): string {
	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: BUSINESS_TIME_ZONE
	}).format(new Date(instant));
}

const eventLabels: Record<StaffDashboardItem['eventType'], string> = {
	BIRTHDAY: 'Birthday party',
	WEDDING: 'Wedding',
	CORPORATE: 'Corporate event',
	SCHOOL_EVENT: 'School event',
	NEIGHBORHOOD_EVENT: 'Neighborhood event',
	OTHER: 'Other event'
};

export function eventTypeLabel(type: StaffDashboardItem['eventType']): string {
	return eventLabels[type];
}

/** Intl accepts exact decimal strings; the cast bridges TS's narrower signature, without conversion. */
export function formatMoney(decimal: string, currency: string): string {
	const fraction = (decimal.split('.')[1] ?? '').replace(/0+$/, '');
	const currencyDigits =
		new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
			.maximumFractionDigits ?? 2;
	const digits = fraction ? Math.max(currencyDigits, fraction.length) : 0;
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency,
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(decimal as unknown as number);
}

export function guestCountLabel(count: number, minimum: boolean): string {
	return `${count}${minimum ? '+' : ''} guest${count === 1 && !minimum ? '' : 's'}${minimum ? ' (minimum)' : ''}`;
}
