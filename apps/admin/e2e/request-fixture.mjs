import { dashboardFixture } from './dashboard-fixture.mjs';

export const mayaId = '00000000-0000-0000-0000-000000000003';
export const mayaDocumentId = '10000000-0000-0000-0000-000000000003';

/** Exact fixture-only resolution, matching the API's HALF_UP percentage rounding.
 * @param {string} total
 * @param {import('../src/lib/request-contract.js').DepositTermsRequest} terms
 * @param {string} currency
 */
export function resolveDepositAmount(total, terms, currency) {
	const digits =
		new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
			.maximumFractionDigits ?? 2;
	/** @param {string} value */
	const minor = (value) => {
		const [whole, fraction = ''] = value.split('.');
		if (!/^\d+(?:\.\d+)?$/.test(value) || fraction.length > digits)
			throw new Error('Invalid fixture money');
		return BigInt(whole + fraction.padEnd(digits, '0'));
	};
	let amount;
	if (terms.type === 'FIXED') amount = minor(terms.amount);
	else {
		const [whole, fraction = ''] = terms.percentage.split('.');
		const denominator = 100n * 10n ** BigInt(fraction.length);
		const numerator = minor(total) * BigInt(whole + fraction);
		amount = (numerator + denominator / 2n) / denominator;
	}
	const serialized = amount.toString().padStart(digits + 1, '0');
	return digits ? `${serialized.slice(0, -digits)}.${serialized.slice(-digits)}` : serialized;
}

/**
 * @param {string} inquiryId
 * @param {string} documentId
 * @param {number} documentVersion
 * @param {string} total
 * @param {import('../src/lib/request-contract.js').DepositTermsRequest} terms
 * @param {string} currency
 * @returns {Pick<import('../src/lib/request-contract.js').StaffRequestResponse, 'proposal' | 'depositRequirement'>}
 */
export function proposalPair(inquiryId, documentId, documentVersion, total, terms, currency) {
	return {
		proposal: {
			id: `3${inquiryId.slice(1)}`,
			inquiryId,
			documentId,
			documentVersion,
			depositRequirementRevision: 1,
			issuedAt: '2026-07-16T19:01:00Z',
			issuedBy: '00000000-0000-0000-0000-000000000001',
			issuanceKind: 'INITIAL'
		},
		depositRequirement: {
			state: 'ACTIVE',
			documentId,
			revision: 1,
			createdAt: '2026-07-16T19:01:00Z',
			approvalDocumentVersion: documentVersion,
			terms: structuredClone(terms),
			requiredAmount: { amount: resolveDepositAmount(total, terms, currency), currency },
			satisfied: false
		}
	};
}

/** @returns {Record<string, import('../src/lib/request-contract.js').CurrentStaffRequest>} */
export function requestFixtures() {
	/** @type {Record<string, import('../src/lib/request-contract.js').CurrentStaffRequest>} */
	const fixtures = Object.fromEntries(
		Object.values(dashboardFixture.workQueue)
			.flatMap((queue) => queue.items)
			.map((item) => {
				const maya = item.inquiryId === mayaId;
				const dan = item.customerName === 'Dan Whitfield';
				const documentId = `1${item.inquiryId.slice(1)}`;
				const suggestedDepositTerms = /** @type {const} */ ({
					type: 'PERCENTAGE',
					percentage: '20'
				});
				const lines = maya
					? [
							{
								id: '20000000-0000-0000-0000-000000000001',
								description: 'Base service',
								subDescription: 'Setup, staff & local travel',
								unitPrice: '205.00',
								subtotal: '205.00',
								taxAmount: '0.00',
								total: '205.00',
								currency: 'USD'
							},
							{
								id: '20000000-0000-0000-0000-000000000002',
								description: 'Ice cream service',
								quantity: '40',
								unitPrice: '4.50',
								subtotal: '180.00',
								taxAmount: '0.00',
								total: '180.00',
								currency: 'USD'
							},
							{
								id: '20000000-0000-0000-0000-000000000003',
								description: 'Waffle cone upgrade',
								quantity: '40',
								unitPrice: '0.75',
								subtotal: '30.00',
								taxAmount: '0.00',
								total: '30.00',
								currency: 'USD'
							}
						]
					: [
							{
								id: `2${item.inquiryId.slice(1)}`,
								description: 'Event service',
								unitPrice: item.total,
								subtotal: item.total,
								taxAmount: '0.00',
								total: item.total,
								currency: 'USD'
							}
						];
				return [
					item.inquiryId,
					{
						payments: [],
						suggestedDepositTerms,
						...(item.stage === 'REQUESTED'
							? { proposal: null, depositRequirement: { state: 'NONE', documentId } }
							: proposalPair(
									item.inquiryId,
									documentId,
									2,
									item.total,
									suggestedDepositTerms,
									item.currency
								)),
						inquiry: {
							id: item.inquiryId,
							customerId: item.customerId,
							name: item.customerName,
							email: maya ? 'maya.torres@example.com' : 'customer@example.com',
							...(maya && {
								message: 'Backyard party, driveway parking is easy. My daughter loves strawberry!'
							}),
							createdAt: maya ? '2026-07-14T19:00:00Z' : item.inquiryCreatedAt,
							requestedService: {
								guestCount: dan ? 120 : 40,
								guestCountIsMinimum: dan,
								items: [
									{ label: 'Vanilla', group: 'Soft serve', key: 'vanilla' },
									{ label: 'Waffle cones', group: 'Vessels', key: 'waffle-cone' }
								]
							},
							zipCode: '93720',
							eventDate: item.eventDate,
							eventType: item.eventType,
							lifecycle: { documentId, stage: item.stage }
						},
						financial: {
							linesAuthoredBy: {
								principalKind: 'SERVICE',
								principalId: '00000000-0000-4000-8000-0000000000aa',
								recordedAt: '2026-07-14T19:00:00Z'
							},
							id: documentId,
							inquiryId: item.inquiryId,
							version: item.stage === 'REQUESTED' ? 1 : item.stage === 'QUOTED' ? 2 : 3,
							createdAt: item.latestDocumentVersionAt,
							stage: item.financialStage,
							lines,
							subtotal: item.total,
							taxAmount: '0.00',
							total: item.total,
							currency: item.currency,
							reconciliation: {
								grossAllocated: '0.00',
								netApplied: '0.00',
								balance: item.balance,
								currency: item.currency
							}
						}
					}
				];
			})
	);
	for (const request of Object.values(fixtures)) {
		if (request.financial.stage !== 'INVOICE' || request.depositRequirement.state !== 'ACTIVE')
			continue;
		const balance = request.financial.reconciliation.balance;
		request.financial.reconciliation.balance = request.financial.total;
		appendPayment(request, request.depositRequirement.requiredAmount.amount, 'CASH', 2);
		request.depositRequirement.satisfied = true;
		const additional =
			fixtureMinor(request.financial.reconciliation.balance) - fixtureMinor(balance);
		if (additional > 0n)
			appendPayment(request, fixtureDecimal(additional), 'CHECK', request.financial.version);
	}
	return fixtures;
}

/** Fixture-only USD ledger arithmetic. Never used by the application. @param {string} value */
export function fixtureMinor(value) {
	if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid fixture USD amount');
	const [whole, fraction = ''] = value.split('.');
	return BigInt(whole + fraction.padEnd(2, '0'));
}
/** @param {bigint} value */
export function fixtureDecimal(value) {
	const digits = (value < 0n ? -value : value).toString().padStart(3, '0');
	return `${value < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
/** @param {import('../src/lib/request-contract.js').CurrentStaffRequest} request @param {string} amount @param {string} method @param {number} documentVersion */
export function appendPayment(request, amount, method, documentVersion) {
	const ordinal = request.payments.length + 1;
	const paymentId = `40000000-0000-0000-0000-${String(ordinal).padStart(12, '0')}`;
	const allocationId = `50000000-0000-0000-0000-${String(ordinal).padStart(12, '0')}`;
	const currency = request.financial.currency;
	const receivedAt = `2026-10-06T19:0${ordinal}:00Z`;
	const payment = { paymentId, amount, method, currency, receivedAt };
	const allocation = {
		allocationId,
		paymentId,
		documentId: request.financial.id,
		documentVersion,
		amount,
		currency,
		allocatedAt: receivedAt
	};
	request.payments.push({
		payment,
		allocations: [allocation],
		refunds: [],
		refundAllocations: [],
		reconciliation: {
			paymentAmount: amount,
			totalRefunded: '0.00',
			netReceived: amount,
			grossAllocated: amount,
			allocationReversals: '0.00',
			refundAllocations: '0.00',
			netAllocated: amount,
			unallocated: '0.00',
			currency
		}
	});
	const reconciliation = request.financial.reconciliation;
	reconciliation.grossAllocated = fixtureDecimal(
		fixtureMinor(reconciliation.grossAllocated) + fixtureMinor(amount)
	);
	reconciliation.netApplied = fixtureDecimal(
		fixtureMinor(reconciliation.netApplied) + fixtureMinor(amount)
	);
	reconciliation.balance = fixtureDecimal(
		fixtureMinor(reconciliation.balance) - fixtureMinor(amount)
	);
	return {
		...payment,
		allocationId,
		documentId: request.financial.id,
		documentVersion,
		allocatedAt: receivedAt,
		reconciliation: structuredClone(reconciliation)
	};
}
/** @param {'quoted' | 'booked' | 'additional' | 'refunded' | 'served'} state @returns {import('../src/lib/request-contract.js').CurrentStaffRequest} */
export function paymentFixture(state = 'quoted') {
	const request = requestFixtures()[mayaId];
	Object.assign(
		request,
		proposalPair(
			mayaId,
			mayaDocumentId,
			2,
			request.financial.total,
			{ type: 'FIXED', amount: '300.00', currency: 'USD' },
			'USD'
		)
	);
	request.inquiry.lifecycle.stage = 'QUOTED';
	request.financial.stage = 'QUOTE';
	request.financial.version = 2;
	if (state === 'quoted') return request;
	appendPayment(request, '300.00', 'CASH', 2);
	request.inquiry.lifecycle.stage = state === 'served' ? 'SERVED' : 'BOOKED';
	request.financial.stage = 'INVOICE';
	request.financial.previousVersion = 2;
	request.financial.version = 3;
	if (request.depositRequirement.state === 'ACTIVE')
		request.depositRequirement.satisfied = state !== 'refunded';
	if (state === 'additional') appendPayment(request, '100.00', 'CASH', 3);
	if (state === 'refunded') {
		const history = request.payments[0];
		history.refunds.push({
			refundId: '60000000-0000-0000-0000-000000000001',
			paymentId: history.payment.paymentId,
			amount: '300.00',
			currency: 'USD',
			method: 'CASH',
			refundedAt: '2026-10-06T20:00:00Z'
		});
		history.refundAllocations.push({
			refundAllocationId: '70000000-0000-0000-0000-000000000001',
			refundId: history.refunds[0].refundId,
			paymentAllocationId: history.allocations[0].allocationId,
			amount: '300.00',
			currency: 'USD',
			allocatedAt: '2026-10-06T20:00:00Z'
		});
		Object.assign(history.reconciliation, {
			totalRefunded: '300.00',
			netReceived: '0.00',
			refundAllocations: '300.00',
			netAllocated: '0.00'
		});
		Object.assign(request.financial.reconciliation, { netApplied: '0.00', balance: '415.00' });
	}
	return request;
}
