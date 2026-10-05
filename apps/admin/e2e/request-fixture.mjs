import { dashboardFixture } from './dashboard-fixture.mjs';

export const mayaId = '00000000-0000-0000-0000-000000000003';
export const mayaDocumentId = '10000000-0000-0000-0000-000000000003';

/** @returns {Record<string, import('../src/lib/request-contract.js').CurrentStaffRequest>} */
export function requestFixtures() {
	return Object.fromEntries(
		Object.values(dashboardFixture.workQueue)
			.flatMap((queue) => queue.items)
			.map((item) => {
				const maya = item.inquiryId === mayaId;
				const dan = item.customerName === 'Dan Whitfield';
				const documentId = `1${item.inquiryId.slice(1)}`;
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
							version: 1,
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
