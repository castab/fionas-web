import { it, expect } from 'vitest';
import { initialQuoteValues, buildCommand, quoteInputErrors } from './quote-builder.js';
import { requestFixtures, mayaId } from '../../e2e/request-fixture.mjs';
import { previewQuote } from '../../e2e/quote-stub.mjs';
it('preserves carried identities, direct overrides, removals, order and bespoke signed lines', () => {
	const data = requestFixtures()[mayaId];
	const v = initialQuoteValues(data);
	const id = v.lines[2].lineItemId;
	v.lines.reverse();
	v.lines[0].unitPrice = '1.125';
	v.lines[0].quantity = '8';
	v.lines[0].note = 'Negotiated';
	v.lines.splice(1, 1);
	v.lines.push(
		{
			key: 'churros',
			description: 'Churros',
			unitPrice: '101.00',
			taxAmount: '0.00',
			currency: 'USD',
			note: 'Bespoke service'
		},
		{
			key: 'courtesy',
			description: 'Courtesy credit',
			unitPrice: '-11.00',
			taxAmount: '0.00',
			currency: 'USD',
			note: 'Returning customer'
		}
	);
	v.description = 'Churro catering';
	expect(quoteInputErrors(v, 'USD')).toEqual({});
	const command = buildCommand(v);
	expect(command.lines[0].lineItemId).toBe(id);
	expect(command.lines.at(-1)?.key).toBe('courtesy');
	expect(command.servicePlan?.lineNotes).toContainEqual({
		key: 'churros',
		note: 'Bespoke service'
	});
	expect(command).not.toHaveProperty('total');
});
it.each([
	['0.125', '3'],
	['1.0000000000001', '8'],
	['NaN', '1'],
	['1e2', '1'],
	['1.00', '0']
])('refuses unsafe exact arithmetic %s × %s', (unitPrice, quantity) => {
	const v = initialQuoteValues(requestFixtures()[mayaId]);
	v.lines[0].unitPrice = unitPrice;
	v.lines[0].quantity = quantity;
	expect(quoteInputErrors(v, 'USD')).toHaveProperty('line-0');
});
it('preserves stable new keys through previews and rejects duplicate identities', () => {
	const v = initialQuoteValues(requestFixtures()[mayaId]);
	v.lines.push({ ...v.lines[0], lineItemId: undefined, key: 'custom_line' });
	expect(buildCommand(v).lines.at(-1)?.key).toBe('custom_line');
	expect(buildCommand(v)).toEqual(buildCommand(v));
	v.lines.push({ ...v.lines[0] });
	expect(quoteInputErrors(v, 'USD')).toHaveProperty('lines');
});
it('accepts a precise 0.125 rate times eight without rounding', () => {
	const v = initialQuoteValues(requestFixtures()[mayaId]);
	v.lines[0].unitPrice = '0.125';
	v.lines[0].quantity = '8';
	expect(quoteInputErrors(v, 'USD')).toEqual({});
});
it('preserves numeric no-ops and makes a service plan optional without discarding notes', () => {
	const data = requestFixtures()[mayaId];
	const v = initialQuoteValues(data);
	v.lines[1].unitPrice = '4.500';
	v.lines[1].quantity = '40.000';
	v.description = '';
	const command = buildCommand(v);
	expect(command.servicePlan).toBeUndefined();
	expect(
		previewQuote({}, data, {
			expectedDocumentVersion: 1,
			...command,
			terms: data.suggestedDepositTerms
		}).body
	).toMatchObject({ financialChange: false, quoteVersion: 2 });
	v.lines[1].note = 'Negotiated rate';
	expect(quoteInputErrors(v, 'USD')).toHaveProperty('service');
});
