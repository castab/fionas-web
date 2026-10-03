import { describe, expect, it } from 'vitest';
import { isInquiryForm } from './commerce-shapes.js';
import { formFixture } from './testing/fake-commerce.js';

describe('inquiry choice metadata at the server boundary', () => {
	function withMetadata(
		type: 'OFFERING_CHOICE' | 'INTEGER_CHOICE' | 'STRING_CHOICE',
		metadata: Record<string, unknown>
	) {
		const form = formFixture();
		const field = form.sections.flatMap((s) => s.fields).find((f) => f.input.type === type)!;
		if (!('options' in field.input)) throw new Error('fixture changed');
		Object.assign(field.input.options[0]!, metadata);
		return form;
	}

	it('accepts the version 11 form with CHIPS and absent or populated metadata', () => {
		expect(isInquiryForm(formFixture())).toBe(true);
		for (const type of ['OFFERING_CHOICE', 'INTEGER_CHOICE', 'STRING_CHOICE'] as const) {
			expect(
				isInquiryForm(
					withMetadata(type, {
						badge: 'Featured',
						statusNote: 'Returning soon',
						infoNote: 'Contains milk'
					})
				)
			).toBe(true);
		}
	});

	it.each(['badge', 'statusNote', 'infoNote'])('accepts nullable offering %s', (key) => {
		expect(isInquiryForm(withMetadata('OFFERING_CHOICE', { [key]: null }))).toBe(true);
	});

	it.each(['badge', 'statusNote', 'infoNote'])(
		'rejects malformed %s on every choice type',
		(key) => {
			for (const type of ['OFFERING_CHOICE', 'INTEGER_CHOICE', 'STRING_CHOICE'] as const) {
				for (const value of [12, false, [], {}]) {
					expect(isInquiryForm(withMetadata(type, { [key]: value }))).toBe(false);
				}
			}
		}
	);

	it.each(['INTEGER_CHOICE', 'STRING_CHOICE'] as const)('rejects null metadata on %s', (type) => {
		expect(isInquiryForm(withMetadata(type, { infoNote: null }))).toBe(false);
	});
});

describe('pricing preview wording at the server boundary', () => {
	type Spot = 'preview' | 'duration' | 'toppings';
	const fields: [Spot, string][] = [
		['preview', 'baseServiceDescription'],
		['preview', 'perGuestDescription'],
		['duration', 'baseServiceSubDescription'],
		['toppings', 'description'],
		['toppings', 'subDescription']
	];

	function withWording(spot: Spot, key: string, value: unknown) {
		const form = formFixture();
		const preview = form.pricingPreview;
		const target =
			spot === 'preview'
				? preview
				: spot === 'duration'
					? preview.durationOptions[0]!
					: preview.toppingAdjustment;
		Object.assign(target, { [key]: value });
		return form;
	}

	it.each(fields)('accepts %s %s as text, null or absent', (spot, key) => {
		expect(isInquiryForm(withWording(spot, key, '1½ hours · setup & travel'))).toBe(true);
		expect(isInquiryForm(withWording(spot, key, null))).toBe(true);
		expect(isInquiryForm(withWording(spot, key, undefined))).toBe(true);
	});

	it.each(fields)('rejects malformed %s %s', (spot, key) => {
		for (const value of [12, false, [], {}]) {
			expect(isInquiryForm(withWording(spot, key, value))).toBe(false);
		}
	});
});
