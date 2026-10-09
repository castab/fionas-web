import { describe, expect, it } from 'vitest';
import type { InquiryForm, InquiryFormField } from '@fionas/shared';
import { MENU_SECTIONS } from './server/menu.js';
import { missingSummary, swirlNote } from './booking-copy.js';

const fields = MENU_SECTIONS.flatMap((s) => s.fields);
const field = (key: string): InquiryFormField => fields.find((f) => f.key === key)!;
const form = { sections: MENU_SECTIONS } as InquiryForm;

describe('swirlNote', () => {
	const soft = field('offering:soft-serve-flavor');

	it('explains the swirl until both flavors are picked, then names it', () => {
		expect(swirlNote(soft, [])).toEqual({
			text: 'The third flavor is always a swirl of your two picks.',
			done: false
		});
		expect(swirlNote(soft, ['vanilla'])?.done).toBe(false);
		expect(swirlNote(soft, ['vanilla', 'horchata'])).toEqual({
			text: 'Your swirl: Vanilla + Horchata — the third handle comes free.',
			done: true
		});
	});

	it('only applies to the pick-two soft-serve question', () => {
		expect(swirlNote(field('offering:hand-scooped-flavor'), [])).toBeUndefined();
		expect(swirlNote(field('name'), [])).toBeUndefined();
	});
});

describe('missingSummary', () => {
	it('lists what is missing in form order using the code-owned nouns', () => {
		expect(
			missingSummary(form, {
				'offering:soft-serve-flavor': 'x',
				name: 'x',
				eventDate: 'x',
				'offering:topping': 'x'
			})
		).toBe('Please add: your name, event date, 2 soft serve flavors, at least 4 toppings.');
	});

	it('is empty when nothing is missing', () => {
		expect(missingSummary(form, {})).toBeNull();
	});

	it('names every required question', () => {
		for (const f of fields.filter((f) => f.required))
			expect(f.presentation.summaryLabel, f.key).toBeTruthy();
	});
});
