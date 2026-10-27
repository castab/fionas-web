import type { StaffDashboardItem } from './dashboard-contract.js';
import type { InquiryStage } from './request-contract.js';

/**
 * Transport types from fionas-commerce's OpenAPI `GET /staff/requests` (`listStaffRequests`)
 * schemas: `StaffRequestListResponse` and `StaffRequestListItemResponse`.
 */
export type StaffRequestListItem = {
	inquiryId: string;
	customerId: string;
	customerName: string;
	customerEmail: string;
	/** A calendar date (YYYY-MM-DD), never an instant. */
	eventDate: string;
	eventType: StaffDashboardItem['eventType'];
	/** The actual lifecycle stage, whatever filter matched it. */
	stage: InquiryStage;
	/** Backend-owned: SERVED with an exactly zero canonical Invoice balance. Never recomputed. */
	needsClosing: boolean;
	documentId: string;
	version: number;
	/** OpenAPI describes ESTIMATE, QUOTE and INVOICE but leaves this transport property a string. */
	financialStage: string;
	/** Exact decimal strings, never business calculations in the UI. */
	total: string;
	totalQualifier: 'EXACT' | 'FROM';
	/** The canonical reconciliation balance; may be negative. */
	balance: string;
	currency: string;
	inquiryCreatedAt: string;
	latestDocumentVersionAt: string;
};

export type StaffRequestListResponse = {
	/** Backend order: inquiry creation time descending, then inquiry UUID descending. */
	items: StaffRequestListItem[];
	/**
	 * Opaque continuation for the same filter and search. CommerceJson omits nulls, so the last page
	 * has no `nextCursor` at all; an explicit null means the same. Never decoded or altered.
	 */
	nextCursor?: string | null;
	/** Every match before pagination, in this response's snapshot. */
	totalCount: number;
};
