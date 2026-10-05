/** @typedef {import('../src/lib/dashboard-contract.js').StaffDashboardItem} Item */

/** @param {number} id @param {Partial<Item>} overrides @returns {Item} */
function item(id, overrides) {
	const uuid = `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`;
	return {
		inquiryId: uuid,
		customerId: uuid,
		documentId: uuid,
		version: 1,
		customerName: 'Customer',
		eventDate: '2026-07-22',
		eventType: 'SCHOOL_EVENT',
		stage: 'REQUESTED',
		financialStage: 'ESTIMATE',
		total: '560.00',
		totalQualifier: 'EXACT',
		balance: '560.00',
		currency: 'USD',
		inquiryCreatedAt: '2026-07-01T19:00:00Z',
		latestDocumentVersionAt: '2026-07-01T19:00:00Z',
		attentionSince: '2026-07-14T19:00:00Z',
		reasons: ['NEEDS_QUOTE'],
		...overrides
	};
}

/** @type {import('../src/lib/dashboard-contract.js').StaffDashboardResponse} */
export const dashboardFixture = {
	asOf: '2026-07-16T19:00:00.000001Z',
	summary: { new: 2, quoted: 1, booked: 1, needsClosing: 1 },
	workQueue: {
		needsReply: {
			items: [
				item(1, {
					customerName: 'Lena Ortiz',
					stage: 'QUOTED',
					financialStage: 'QUOTE',
					reasons: ['CUSTOMER_COMMUNICATION_UNACKNOWLEDGED']
				}),
				item(2, {
					customerName: 'Marcus Lee',
					eventDate: '2026-07-18',
					eventType: 'NEIGHBORHOOD_EVENT',
					stage: 'CLOSED',
					financialStage: 'INVOICE',
					total: '550.00',
					balance: '0.00',
					attentionSince: '2026-07-15T19:00:00Z',
					reasons: ['CUSTOMER_COMMUNICATION_UNACKNOWLEDGED']
				})
			]
		},
		needsQuote: {
			items: [
				item(3, {
					customerName: 'Maya Torres',
					eventDate: '2026-07-25',
					eventType: 'BIRTHDAY',
					total: '415.00',
					balance: '415.00'
				}),
				item(4, {
					customerName: 'Dan Whitfield',
					eventDate: '2026-08-08',
					eventType: 'CORPORATE',
					total: '985.00',
					balance: '985.00',
					totalQualifier: 'FROM',
					attentionSince: '2026-07-15T19:00:00Z'
				})
			]
		},
		needsResolution: {
			items: [
				item(5, {
					customerName: 'Priya Nathan',
					eventDate: '2026-06-30',
					eventType: 'OTHER',
					stage: 'SERVED',
					financialStage: 'INVOICE',
					total: '492.50',
					balance: '0.00',
					attentionSince: '2026-06-10T19:00:00Z',
					servedAt: '2026-06-10T19:00:00Z',
					reasons: ['READY_TO_CLOSE']
				})
			]
		}
	}
};
