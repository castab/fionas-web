// Synthetic requests for every Quote/Invoice revision state the admin must understand. Each is built
// by running the same stub rules the e2e backend applies, never by hand-editing ledger fields, so a
// fixture can only be a state the backend could actually produce.
import {
	appendPayment,
	declinedFixture,
	mayaId,
	paymentFixture,
	requestFixtures,
	withServicePlan
} from './request-fixture.mjs';
import { amendInvoiceFixture, currentLines, reviseQuoteFixture } from './revision-stub.mjs';

/** @typedef {import('../src/lib/request-contract.js').CurrentStaffRequest} Request */

/** Current lines with Maya's service line priced differently, ids kept (a REPLACED line).
 * @param {Request} request @param {string} unitPrice */
export function repricedLines(request, unitPrice) {
	return currentLines(request).map((line) =>
		line.lineItemId === request.financial.lines[0].id ? { ...line, unitPrice } : line
	);
}
/** Current lines plus one new keyed flat charge. @param {Request} request @param {string} amount */
export function withCharge(request, amount = '50.00') {
	return [
		...currentLines(request),
		{
			key: 'extra-hour',
			description: 'Extra hour',
			unitPrice: amount,
			taxAmount: '0.00',
			currency: 'USD'
		}
	];
}
const percent = (/** @type {string} */ percentage) => ({ type: 'PERCENTAGE', percentage });

/** Maya's QUOTED request carrying an approved plan: Quote v2, plan revision 1. */
export function quotedWithPlan() {
	return withServicePlan(paymentFixture('quoted'));
}
/** Same, but the deposit was negotiated to a fixed amount rather than the suggested percentage. */
export function negotiatedQuote() {
	const request = quotedWithPlan();
	return reviseQuoteFixture(request, {
		expectedDocumentVersion: request.financial.version,
		expectedDepositRequirementRevision: 1,
		lines: currentLines(request),
		terms: { type: 'FIXED', amount: '250.00', currency: 'USD' },
		servicePlanAction: 'RETAIN'
	});
}

/**
 * @typedef {'unquoted' | 'quoted' | 'quote-financial-revision' | 'quote-deposit-revision' |
 *  'quote-service-revision' | 'booked' | 'booked-additional' | 'invoice-financial-amendment' |
 *  'invoice-service-amendment' | 'served' | 'closed' | 'declined' | 'plan-cleared' |
 *  'historical-plan' | 'overpaid'} RevisionState
 * @param {RevisionState} state @returns {Request}
 */
export function revisionFixture(state) {
	if (state === 'unquoted') return requestFixtures()[mayaId];
	if (state === 'declined') return declinedFixture();
	const quoted = quotedWithPlan();
	const quoteEdit = (/** @type {object} */ extra) => ({
		expectedDocumentVersion: quoted.financial.version,
		expectedDepositRequirementRevision: 1,
		lines: currentLines(quoted),
		terms: structuredClone(/** @type {*} */ (quoted.depositRequirement).terms),
		servicePlanAction: 'RETAIN',
		...extra
	});
	switch (state) {
		case 'quoted':
			return quoted;
		// A repriced line with the plan retained: the plan keeps its original snapshot reference.
		case 'quote-financial-revision':
		case 'historical-plan':
			return reviseQuoteFixture(quoted, quoteEdit({ lines: repricedLines(quoted, '300.00') }));
		case 'quote-deposit-revision':
			return reviseQuoteFixture(quoted, quoteEdit({ terms: percent('35') }));
		case 'quote-service-revision':
			return reviseQuoteFixture(
				quoted,
				quoteEdit({
					servicePlanAction: 'REPLACE',
					servicePlan: {
						description: 'Chocolate service for the larger party',
						guestCount: 60,
						items: [{ label: 'Chocolate', group: 'Soft serve', key: null }],
						lineNotes: []
					}
				})
			);
		default:
			break;
	}
	const booked = bookedFrom(quoted);
	switch (state) {
		case 'booked':
			return booked;
		case 'booked-additional':
			appendPayment(booked, '100.00', 'CASH', booked.financial.version);
			return booked;
		case 'invoice-financial-amendment':
			return amendInvoiceFixture(booked, {
				expectedDocumentVersion: booked.financial.version,
				lines: withCharge(booked, '250.00'),
				servicePlanAction: 'RETAIN'
			});
		case 'invoice-service-amendment':
			return amendInvoiceFixture(booked, {
				expectedDocumentVersion: booked.financial.version,
				lines: currentLines(booked),
				servicePlanAction: 'REPLACE',
				servicePlan: {
					description: 'Chocolate topping instead of vanilla',
					guestCount: 40,
					items: [{ label: 'Chocolate', group: 'Toppings', key: null }],
					lineNotes: []
				}
			});
		case 'plan-cleared':
			return amendInvoiceFixture(booked, {
				expectedDocumentVersion: booked.financial.version,
				lines: currentLines(booked),
				servicePlanAction: 'CLEAR'
			});
		case 'overpaid': {
			// Priced well below what has already been paid; nothing is refunded automatically.
			const request = amendInvoiceFixture(booked, {
				expectedDocumentVersion: booked.financial.version,
				lines: repricedLines(booked, '1.00').map((line, i) =>
					i === 0 ? line : { ...line, unitPrice: '0.00', quantity: line.quantity }
				),
				servicePlanAction: 'RETAIN'
			});
			return request;
		}
		case 'served':
		case 'closed': {
			booked.inquiry.lifecycle.stage = 'SERVED';
			booked.inquiry.lifecycle.served = {
				occurredAt: '2026-10-06T23:42:00Z',
				principalKind: 'USER',
				principalId: '00000000-0000-0000-0000-000000000001'
			};
			if (state === 'closed') {
				appendPayment(
					booked,
					booked.financial.reconciliation.balance,
					'CHECK',
					booked.financial.version
				);
				booked.inquiry.lifecycle.stage = 'CLOSED';
				booked.inquiry.lifecycle.closed = {
					occurredAt: '2026-10-07T00:18:00Z',
					principalKind: 'USER',
					principalId: '00000000-0000-0000-0000-000000000001'
				};
			}
			return booked;
		}
		default:
			throw new Error(`Unknown revision fixture: ${state}`);
	}
}

/** Takes the exact deposit, as the backend would, and books the event.
 * @param {Request} request */
function bookedFrom(request) {
	const deposit = /** @type {*} */ (request.depositRequirement);
	appendPayment(request, deposit.requiredAmount.amount, 'CASH', request.financial.version);
	deposit.satisfied = true;
	request.financial.previousVersion = request.financial.version;
	request.financial.version++;
	request.financial.stage = 'INVOICE';
	request.inquiry.lifecycle.stage = 'BOOKED';
	request.acceptedServicePlan = request.servicePlan ?? undefined;
	return request;
}
