/** Transport types from the supplied fionas-commerce OpenAPI /staff/dashboard schemas. */
export type StaffDashboardItem = {
	inquiryId: string;
	customerId: string;
	customerName: string;
	eventDate: string;
	eventType: 'BIRTHDAY' | 'WEDDING' | 'CORPORATE' | 'SCHOOL_EVENT' | 'NEIGHBORHOOD_EVENT' | 'OTHER';
	stage: 'REQUESTED' | 'QUOTED' | 'BOOKED' | 'SERVED' | 'CLOSED';
	documentId: string;
	version: number;
	financialStage: string;
	/** Exact decimal strings, never business calculations in the UI. */
	total: string;
	totalQualifier: 'EXACT' | 'FROM';
	balance: string;
	currency: string;
	inquiryCreatedAt: string;
	latestDocumentVersionAt: string;
	attentionSince: string;
	servedAt?: string;
	reasons: (
		| 'CUSTOMER_COMMUNICATION_UNACKNOWLEDGED'
		| 'NEEDS_QUOTE'
		| 'QUOTE_STALE'
		| 'EVENT_DATE_PASSED_UNSERVED'
		| 'SERVED_WITH_BALANCE_DUE'
		| 'READY_TO_CLOSE'
	)[];
};

export type StaffDashboardResponse = {
	asOf: string;
	summary: { new: number; quoted: number; booked: number; needsClosing: number };
	workQueue: {
		needsReply: { items: StaffDashboardItem[] };
		needsQuote: { items: StaffDashboardItem[] };
		needsResolution: { items: StaffDashboardItem[] };
	};
};
