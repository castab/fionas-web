import { describe, expect, it } from 'vitest';
import {
	buildGroup,
	dateTile,
	daysBetween,
	estimateLabel,
	formatMoney,
	formatToday,
	requestCard,
	todayIso,
	todayLine,
	waitLabel,
	type RequestCardInput
} from './dashboard.js';
import { PREVIEW_TODAY, previewDashboard } from './dashboard-fixtures.js';

const input = (overrides: Partial<RequestCardInput> = {}): RequestCardInput => ({
	id: 'r1',
	name: 'Maya Torres',
	eventDate: '2026-07-25',
	eventTypeLabel: 'Birthday party',
	waitingSince: '2026-07-14',
	estimateTotal: '415.00',
	estimateIsMinimum: false,
	...overrides
});

describe('today', () => {
	it('uses the business calendar, not UTC', () => {
		// 03:30 UTC on Jul 17 is still the evening of Jul 16 in Fresno.
		const now = new Date('2026-07-17T03:30:00Z');
		expect(todayIso(now)).toBe('2026-07-16');
		expect(formatToday(now)).toBe('Thursday, July 16');
	});

	it('adds the waiting count only when it is known', () => {
		expect(todayLine('Thursday, July 16', null)).toBe('Thursday, July 16');
		expect(todayLine('Thursday, July 16', 0)).toBe('Thursday, July 16 · 0 requests waiting on you');
		expect(todayLine('Thursday, July 16', 1)).toBe('Thursday, July 16 · 1 request waiting on you');
		expect(todayLine('Thursday, July 16', 4)).toBe('Thursday, July 16 · 4 requests waiting on you');
	});
});

describe('calendar math', () => {
	it('counts whole days across month and DST boundaries', () => {
		expect(daysBetween('2026-07-14', '2026-07-16')).toBe(2);
		expect(daysBetween('2026-06-30', '2026-07-01')).toBe(1);
		expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1);
		expect(daysBetween('2026-07-16', '2026-07-14')).toBe(-2);
	});

	it('reads event dates as calendar dates', () => {
		expect(dateTile('2026-07-25')).toEqual({ month: 'Jul', day: '25' });
		expect(dateTile('2026-08-01')).toEqual({ month: 'Aug', day: '1' });
	});

	it('labels the wait', () => {
		expect(waitLabel(0)).toBe('Came in today');
		expect(waitLabel(1)).toBe('Waiting 1 day');
		expect(waitLabel(36)).toBe('Waiting 36 days');
	});
});

describe('money', () => {
	it('formats exact decimals, dropping whole cents', () => {
		expect(formatMoney('415.00')).toBe('$415');
		expect(formatMoney('985')).toBe('$985');
		expect(formatMoney('1234.5')).toBe('$1,234.50');
		expect(formatMoney('1234567.25')).toBe('$1,234,567.25');
		expect(formatMoney('0.10')).toBe('$0.10');
		expect(formatMoney('-12.00')).toBe('-$12');
	});

	it('prefixes a minimum-guest estimate with "from"', () => {
		expect(estimateLabel('985.00', true)).toBe('from $985');
		expect(estimateLabel('415.00', false)).toBe('$415');
		expect(estimateLabel(null, true)).toBeNull();
	});
});

describe('request cards', () => {
	it('maps an input to the card view', () => {
		expect(requestCard(input(), '2026-07-16')).toEqual({
			id: 'r1',
			name: 'Maya Torres',
			dateMonth: 'Jul',
			dateDay: '25',
			waitDays: 2,
			waitMeta: 'Waiting 2 days · Birthday party',
			estLabel: '$415',
			urgent: false
		});
	});

	it('never shows a negative wait', () => {
		expect(requestCard(input({ waitingSince: '2026-07-20' }), '2026-07-16').waitMeta).toBe(
			'Came in today · Birthday party'
		);
	});

	it('sorts a group longest-waiting first and marks urgency', () => {
		const group = buildGroup(
			[
				input({ id: 'a', waitingSince: '2026-07-15' }),
				input({ id: 'b', waitingSince: '2026-07-01' }),
				input({ id: 'c', waitingSince: '2026-07-10' })
			],
			'2026-07-16',
			{ urgent: true }
		);
		expect(group.map((card) => card.id)).toEqual(['b', 'c', 'a']);
		expect(group.every((card) => card.urgent)).toBe(true);
	});
});

describe('preview fixtures', () => {
	it('match the design on its pinned day', () => {
		const view = previewDashboard(PREVIEW_TODAY);
		expect(view.stats.map((s) => s.count)).toEqual([2, 1, 1, 1]);
		expect(view.waitingCount).toBe(4);
		expect(view.replyGroup.map((c) => c.name)).toEqual(['Lena Ortiz', 'Marcus Lee']);
		expect(view.quoteGroup[1]).toMatchObject({ name: 'Dan Whitfield', estLabel: 'from $985' });
		expect(view.resolutionGroup[0]).toMatchObject({
			urgent: true,
			waitMeta: 'Waiting 36 days · Retirement party'
		});
	});
});
