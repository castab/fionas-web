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
