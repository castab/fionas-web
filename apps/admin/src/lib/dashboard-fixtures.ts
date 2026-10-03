import { buildGroup, type DashboardView, type RequestCardInput } from './dashboard.js';

/**
 * Sample data for the dev-only `/?preview` dashboard, modelled on the "Admin Console v4" design's
 * seed requests. It runs through the same mapping as live data will, so the cards can be checked
 * against the design before the API can sort requests (docs/admin-dashboard-report.md).
 * Never shown in a production build.
 */

/** The design's "today", so the wait labels match its screenshots. */
export const PREVIEW_TODAY = '2026-07-16';

const replyInputs: RequestCardInput[] = [
	{
		id: 'preview-r5',
		name: 'Marcus Lee',
		eventDate: '2026-07-18',
		eventTypeLabel: 'Block party',
		waitingSince: '2026-07-15',
		estimateTotal: '498.00',
		estimateIsMinimum: false
	},
	{
		id: 'preview-r4',
		name: 'Lena Ortiz',
		eventDate: '2026-07-22',
		eventTypeLabel: 'School event',
		waitingSince: '2026-07-14',
		estimateTotal: '560.00',
		estimateIsMinimum: false
	}
];

const quoteInputs: RequestCardInput[] = [
	{
		id: 'preview-r2',
		name: 'Dan Whitfield',
		eventDate: '2026-08-08',
		eventTypeLabel: 'Company picnic',
		waitingSince: '2026-07-15',
		estimateTotal: '985.00',
		estimateIsMinimum: true
	},
	{
		id: 'preview-r1',
		name: 'Maya Torres',
		eventDate: '2026-07-25',
		eventTypeLabel: 'Birthday party',
		waitingSince: '2026-07-14',
		estimateTotal: '415.00',
		estimateIsMinimum: false
	}
];

const resolutionInputs: RequestCardInput[] = [
	{
		id: 'preview-r10',
		name: 'Priya Nathan',
		eventDate: '2026-06-30',
		eventTypeLabel: 'Retirement party',
		waitingSince: '2026-06-10',
		estimateTotal: '492.50',
		estimateIsMinimum: false
	}
];

export function previewDashboard(today: string = PREVIEW_TODAY): DashboardView {
	const replyGroup = buildGroup(replyInputs, today);
	const quoteGroup = buildGroup(quoteInputs, today);
	return {
		stats: [
			{ label: 'New', count: 2, tone: 'olive' },
			{ label: 'Quoted', count: 1, tone: 'olive-soft' },
			{ label: 'Booked', count: 1, tone: 'moss' },
			{ label: 'Needs closing', count: 1, tone: 'rust' }
		],
		replyGroup,
		quoteGroup,
		resolutionGroup: buildGroup(resolutionInputs, today, { urgent: true }),
		waitingCount: replyGroup.length + quoteGroup.length
	};
}
