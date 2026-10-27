/** @typedef {import('../src/lib/dashboard-contract.js').StaffDashboardItem} Item */
/** @typedef {Omit<Item, 'stage'> & { stage: import('../src/lib/request-contract.js').InquiryStage }} RequestItem */

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
	// Agrees with the queues plus `quietRequestItems` (Sofia is quoted, Oliver booked).
	summary: { new: 2, quoted: 2, booked: 2, needsClosing: 1 },
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

/**
 * Requests in no attention queue, so only the Requests index finds them: a quoted request waiting
 * quietly on its deposit, a booked event, and a declined request (excluded from every queue and
 * count). They share the queue items' shape so `requestFixtures` can project each one.
 * @type {RequestItem[]}
 */
export const quietRequestItems = [
	item(6, {
		customerName: 'Sofia Ramirez-Delacruz',
		eventDate: '2026-09-12',
		eventType: 'WEDDING',
		stage: 'QUOTED',
		financialStage: 'QUOTE',
		total: '1240.00',
		balance: '1240.00',
		inquiryCreatedAt: '2026-07-10T19:00:00Z',
		latestDocumentVersionAt: '2026-07-11T18:00:00Z',
		reasons: []
	}),
	item(7, {
		customerName: 'Oliver Grant',
		eventDate: '2026-08-22',
		eventType: 'CORPORATE',
		stage: 'BOOKED',
		financialStage: 'INVOICE',
		total: '720.00',
		balance: '576.00',
		inquiryCreatedAt: '2026-06-20T19:00:00Z',
		latestDocumentVersionAt: '2026-06-24T18:00:00Z',
		reasons: []
	}),
	{
		...item(8, {
			customerName: 'Hannah Kim',
			eventDate: '2026-08-15',
			eventType: 'BIRTHDAY',
			total: '380.00',
			balance: '380.00',
			inquiryCreatedAt: '2026-07-05T19:00:00Z',
			latestDocumentVersionAt: '2026-07-05T19:00:00Z',
			reasons: []
		}),
		stage: 'DECLINED'
	}
];
