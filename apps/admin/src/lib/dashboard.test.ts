import { describe, expect, it } from 'vitest';
import {
	amountLabel,
	dashboardView,
	dateTile,
	formatMoney,
	formatToday,
	requestCard,
	todayLine,
	uniqueWaitingCount,
	waitingAge
} from './dashboard.js';
import { dashboardFixture } from '../../e2e/dashboard-fixture.mjs';

const asOf = dashboardFixture.asOf;

describe('dashboard presentation', () => {
	it('formats the snapshot date on the business calendar, not the browser clock', () => {
		expect(formatToday('2026-07-17T03:30:00Z')).toBe('Thursday, July 16');
		expect(dashboardView(dashboardFixture).dateLabel).toBe('Thursday, July 16');
	});
	it('formats date-only events without timezone drift, including month and year boundaries', () => {
		expect(dateTile('2026-07-22')).toEqual({ month: 'Jul', day: '22' });
		expect(dateTile('2026-08-01')).toEqual({ month: 'Aug', day: '1' });
		expect(dateTile('2027-01-01')).toEqual({ month: 'Jan', day: '1' });
		expect(dateTile('2028-02-29')).toEqual({ month: 'Feb', day: '29' });
	});
	it('formats exact currency and material cents without floating-point loss', () => {
		expect(formatMoney('560.00', 'USD')).toBe('$560');
		expect(formatMoney('492.50', 'USD')).toBe('$492.50');
		expect(formatMoney('0.10', 'USD')).toBe('$0.10');
		expect(formatMoney('9007199254740993.50', 'USD')).toBe('$9,007,199,254,740,993.50');
		expect(formatMoney('1234.5', 'EUR')).toBe('€1,234.50');
		expect(formatMoney('1234', 'JPY')).toBe('¥1,234');
	});
	it('uses EXACT/FROM only from the qualifier', () => {
		expect(amountLabel({ total: '560', totalQualifier: 'EXACT', currency: 'USD' })).toBe('$560');
		expect(amountLabel({ total: '985', totalQualifier: 'FROM', currency: 'USD' })).toBe(
			'from $985'
		);
	});
	it('uses attention onset and asOf for completed elapsed days', () => {
		expect(waitingAge('2026-07-14T19:00:00Z', asOf)).toBe('Waiting 2 days');
		expect(waitingAge('2026-07-15T19:00:00Z', asOf)).toBe('Waiting 1 day');
		expect(waitingAge('2026-07-16T18:00:00Z', asOf)).toBe('Waiting less than a day');
		expect(waitingAge(asOf, asOf)).toBe('Waiting less than a day');
		expect(waitingAge('2026-07-20T00:00:00Z', asOf)).toBe('Waiting less than a day');
		// Elapsed days across DST, rather than a local-date reclassification.
		expect(waitingAge('2026-03-08T09:00:00Z', '2026-03-09T08:00:00Z')).toBe(
			'Waiting less than a day'
		);
	});
	it('maps display fields without consulting lifecycle, financial stage, or reasons', () => {
		const item = dashboardFixture.workQueue.needsQuote.items[1];
		expect(
			requestCard({ ...item, financialStage: 'QUOTE', stage: 'SERVED', reasons: [] }, asOf)
		).toMatchObject({
			name: 'Dan Whitfield',
			dateMonth: 'Aug',
			dateDay: '8',
			estLabel: 'from $985',
			waitMeta: 'Waiting 1 day · Corporate event'
		});
	});
	it('uses returned counts directly and preserves every backend queue and its ordering', () => {
		const response = structuredClone(dashboardFixture);
		response.summary = { new: 17, quoted: 8, booked: 12, needsClosing: 3 };
		response.workQueue.needsReply.items.reverse();
		const view = dashboardView(response);
		expect(view.stats.map((stat) => stat.count)).toEqual([17, 8, 12, 3]);
		expect(view.replyGroup.map((card) => card.name)).toEqual(['Marcus Lee', 'Lena Ortiz']);
		expect(view.quoteGroup.map((card) => card.name)).toEqual(['Maya Torres', 'Dan Whitfield']);
		expect(view.resolutionGroup[0]).toMatchObject({
			name: 'Priya Nathan',
			urgent: true,
			estLabel: '$492.50'
		});
	});
	it('counts unique inquiries across all three queues without removing overlapping cards', () => {
		const response = structuredClone(dashboardFixture);
		response.workQueue.needsReply.items.push(response.workQueue.needsQuote.items[0]);
		response.workQueue.needsResolution.items.push(response.workQueue.needsQuote.items[0]);
		expect(uniqueWaitingCount(response.workQueue)).toBe(5);
		expect(dashboardView(response).replyGroup).toHaveLength(3);
		expect(dashboardView(response).resolutionGroup).toHaveLength(2);
		expect(todayLine('Thursday, July 16', 5)).toBe('Thursday, July 16 · 5 requests waiting on you');
		expect(todayLine('Thursday, July 16', 1)).toContain('1 request waiting');
	});
	it('presents a successful empty projection as zero, with empty queues', () => {
		const response = {
			asOf,
			summary: { new: 0, quoted: 0, booked: 0, needsClosing: 0 },
			workQueue: {
				needsReply: { items: [] },
				needsQuote: { items: [] },
				needsResolution: { items: [] }
			}
		};
		expect(dashboardView(response).waitingCount).toBe(0);
		expect(dashboardView(response).stats.every((stat) => stat.count === 0)).toBe(true);
	});
});
