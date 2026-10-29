import type {
	FinancialDocumentResponse,
	HistoricalDepositRequirement,
	InquiryMilestone,
	InquiryProposalResponse
} from './request-contract.js';

/** fionas-commerce PR #32, 9f2bc02. Optional properties are omitted by CommerceJson. */
export type CommunicationSummary = {
	needsReply: boolean;
	throughRecordedOrder: number;
	unacknowledgedSince?: string | null;
	latestEmailAt?: string | null;
	lastAcknowledged?: InquiryMilestone | null;
};
export type ConversationState = 'READY' | 'EMPTY' | 'MISSING' | 'UNAVAILABLE' | 'FORBIDDEN';
export type TimelineActor = Pick<InquiryMilestone, 'principalKind' | 'principalId'>;
export type SendState = 'received' | 'pending' | 'accepted' | 'failed' | 'indeterminate';
export type DeliveryState =
	'unknown' | 'delivered' | 'delivery_delayed' | 'bounced' | 'complained' | 'suppressed' | 'failed';
type Entry = { id: string; occurredAt: string };
export type ConversationMessage = Entry & {
	kind: 'MESSAGE';
	messageId: string;
	direction: 'inbound' | 'outbound';
	senderAddress: string;
	senderName?: string | null;
	recipient: string;
	text?: string | null;
	sendState: SendState;
	deliveryState?: DeliveryState | null;
};
type Allocation = {
	documentId: string;
	documentVersion: number;
	amount: string;
	currency: string;
	allocatedAt: string;
};
export type PaymentAllocation = Allocation & {
	allocationId: string;
	canonical: boolean;
	documentStage?: string | null;
};
export type RefundUnwind = Allocation & { refundAllocationId: string; paymentAllocationId: string };
type Receipt = {
	paymentId: string;
	amount: string;
	currency: string;
	method: string;
	externalReference?: { provider: string; reference: string } | null;
};
export type TimelineItem =
	| ConversationMessage
	| (Entry & {
			kind: 'QUOTE_PUBLISHED';
			proposal: InquiryProposalResponse;
			financial: FinancialDocumentResponse;
			depositRequirement: HistoricalDepositRequirement;
			actor: TimelineActor;
	  })
	| (Entry & { kind: 'INVOICE_AMENDED'; financial: FinancialDocumentResponse })
	| (Entry &
			Receipt & {
				kind: 'PAYMENT_RECORDED';
				classification: 'DEPOSIT' | 'ADDITIONAL';
				proposalId?: string | null;
				depositRequirementRevision?: number | null;
				allocations: PaymentAllocation[];
			})
	| (Entry &
			Receipt & {
				kind: 'REFUND_RECORDED';
				refundId: string;
				paymentClassification: 'DEPOSIT' | 'ADDITIONAL';
				unwound: RefundUnwind[];
			})
	| (Entry & { kind: 'COMMUNICATION_ACKNOWLEDGED' | 'SERVED' | 'CLOSED'; actor: TimelineActor })
	| (Entry & { kind: 'DECLINED'; actor: TimelineActor; reason: string });
export type StaffTimeline = {
	conversation: {
		state: ConversationState;
		subject?: string | null;
		providerState?: string | null;
		latestMessageId?: string | null;
	};
	attention: CommunicationSummary;
	items: TimelineItem[];
};
export type ReplyExpectation =
	| { expectedLatestMessageId: string; expectEmptyConversation?: never }
	| { expectEmptyConversation: true; expectedLatestMessageId?: never };
export type StaffReplyRequest = ReplyExpectation & { body: string };
export type StaffReplyResponse = {
	outcome: 'ACCEPTED' | 'UNKNOWN';
	replayed: boolean;
	conversationId?: string | null;
	messageId?: string | null;
	sendState?: 'pending' | 'accepted' | null;
};
export type ReplyDraft = {
	key: string;
	body: string;
	expectation: ReplyExpectation;
	state: 'draft' | 'uncertain' | 'rejected' | 'accepted';
	message?: string;
};
export type ConversationActionResult = {
	conversationError?: string;
	reply?: ReplyDraft;
	recoveryLost?: boolean;
};
