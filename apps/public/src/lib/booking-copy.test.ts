import { describe, expect, it } from 'vitest';
import type { InquiryForm, InquiryFormField } from '@fionas/shared';
import { MENU_SECTIONS } from './server/menu.js';
import { missingSummary, swirlNote } from './booking-copy.js';

const fields = MENU_SECTIONS.flatMap((s) => s.fields);
const field = (key: string): InquiryFormField => fields.find((f) => f.key === key)!;
const form = { sections: MENU_SECTIONS } as InquiryForm;

describe('swirlNote', () => {
	// Soft serve is off the menu until a machine is sourced; the helper stays ready for its return.
	const flavor = (key: string, displayName: string) => ({
		key,
		category: 'soft-serve-flavor',
		displayName,
		selectionState: 'ENABLED',
		availability: 'AVAILABLE'
	});
	const soft = {
		key: 'offering:soft-serve-flavor',
		label: 'Soft serve — pick 2',
		submissionPointer: '/serviceInputs/selections',
		required: true,
		input: {
			type: 'OFFERING_CHOICE',
			category: 'soft-serve-flavor',
			minSelections: 2,
			maxSelections: 2,
			options: [flavor('vanilla', 'Vanilla'), flavor('cookies-and-cream', 'Cookies & Cream')]
		},
		presentation: { control: 'CHIPS' }
	} as unknown as InquiryFormField;

	it('explains the swirl until both flavors are picked, then names it', () => {
		expect(swirlNote(soft, [])).toEqual({
			text: 'The third flavor is always a swirl of your two picks.',
			done: false
		});
		expect(swirlNote(soft, ['vanilla'])?.done).toBe(false);
		expect(swirlNote(soft, ['vanilla', 'cookies-and-cream'])).toEqual({
			text: 'Your swirl: Vanilla + Cookies & Cream — the third handle comes free.',
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
				'offering:hand-scooped-flavor': 'x',
				name: 'x',
				eventDate: 'x',
				'offering:topping': 'x',
				'offering:cone-option': 'x'
			})
		).toBe(
			'Please add: your name, event date, 4 hand-scooped flavors, at least 4 toppings, at least 1 cone or cup.'
		);
	});

	it('is empty when nothing is missing', () => {
		expect(missingSummary(form, {})).toBeNull();
	});

	it('names every required question', () => {
		for (const f of fields.filter((f) => f.required))
			expect(f.presentation.summaryLabel, f.key).toBeTruthy();
	});
});
