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
			principalKind: 'USER',
			principalId: '00000000-0000-0000-0000-000000000001',
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
	return Object.fromEntries(
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
								subDescription: '90 minutes · setup, staff & local travel',
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
							pricingInputs: {
								catalogRevision: 11,
								guestCount: dan ? 120 : 40,
								guestCountIsMinimum: dan,
								durationMinutes: dan ? 180 : 90,
								selections: [
									{ category: 'soft-serve', offerings: ['vanilla', 'chocolate'] },
									{
										category: 'hand-scooped',
										offerings: ['chocolate-chip', 'strawberry', 'rocky-road']
									},
									{
										category: 'toppings',
										offerings: ['rainbow-sprinkles', 'hot-fudge', 'crushed-oreo']
									},
									{ category: 'cones-cups', offerings: ['waffle-cone'] }
								]
							},
							zipCode: '93720',
							eventDate: item.eventDate,
							eventType: item.eventType,
							lifecycle: { documentId, stage: item.stage }
						},
						financial: {
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
}
