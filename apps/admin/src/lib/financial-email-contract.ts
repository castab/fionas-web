import type { ReplyExpectation, TimelineActor } from './conversation-contract.js';
import type { FinancialDocumentResponse } from './request-contract.js';

/**
 * Staff-reviewed financial-document emails: fionas-commerce PR #39
 * (`docs/financial-emails-frontend-handoff.md`, `FinancialEmailRoutes.kt`). Commerce renders the
 * email, resolves the recipient, issues the payment link and owns idempotency; the admin only
 * carries reviewed identities, an optional staff message, the review token and the original
 * conversation expectation. Optional properties are omitted by CommerceJson.
 */
export type FinancialEmailKind = 'QUOTE' | 'INVOICE';

/** Preview and send each require all five; no role receives them automatically. */
export const FINANCIAL_EMAIL_PERMISSIONS = [
	'fionas.inquiries.read',
	'commerce.financial-document.read',
	'fionas.communications.read',
	'fionas.communications.send',
	'fionas.payment-access.manage'
] as const;

/** `PreviewFinancialEmailRequest`, also the `email` of a send. Never amounts, addresses or HTML. */
export type FinancialEmailIntent = {
	kind: FinancialEmailKind;
	/** `financial.id`: the canonical lineage. */
	documentId: string;
	/** `financial.version`: the ledger snapshot version. */
	expectedDocumentVersion: number;
	/** `currentQuoteRevision` / `currentInvoiceRevision`: the business revision. */
	expectedBusinessRevision: number;
	/** QUOTE only: the latest publication. */
	proposalId?: string;
	/** QUOTE only: that publication's approved deposit revision. */
	expectedDepositRequirementRevision?: number;
	/** Normalized staff prose; omitted means the backend's default greeting. */
	message?: string;
};

/** `FinancialEmailPreviewResponse` (200, no-store, write-free). */
export type FinancialEmailPreview = {
	kind: FinancialEmailKind;
	recipientName: string;
	recipientAddress: string;
	subject: string;
	/** Escaped email HTML with an inert example.invalid payment button: display-only content. */
	html: string;
	text: string;
	financial: FinancialDocumentResponse;
	businessRevision: number;
	requiredPayment: string;
	paidAmount: string;
	balance: string;
	/** QUOTE only: total less the approved deposit. */
	balanceAfterDeposit?: string;
	reviewToken: string;
};

/** `SendFinancialEmailRequest`, with exactly one original conversation expectation. */
export type FinancialEmailSendRequest = ReplyExpectation & {
	email: FinancialEmailIntent;
	reviewToken: string;
};

/** `FinancialEmailSendResponse`: 201 accepted, 200 accepted replay, 202 UNKNOWN. Never delivery. */
export type FinancialEmailSendResponse = {
	sendId: string;
	outcome: 'ACCEPTED' | 'UNKNOWN';
	replayed: boolean;
	conversationId?: string | null;
	messageId?: string | null;
	sendState?: string | null;
};

export type FinancialEmailOutcome = 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';

/** `FinancialEmailHistoryResponse`: safe command history, including UNKNOWN and REJECTED commands. */
export type FinancialEmailHistory = {
	sendId: string;
	kind: FinancialEmailKind;
	documentId: string;
	documentVersion: number;
	businessRevision: number;
	proposalId?: string | null;
	/** Commerce's comparison with the current canonical document, business revision and proposal. */
	current: boolean;
	outcome: FinancialEmailOutcome;
	requestedAt: string;
	acceptedAt?: string | null;
	/** Always the staff USER who requested it. */
	actor: TimelineActor;
	conversationId?: string | null;
	messageId?: string | null;
	/** Provider send state when known (pending/accepted/…); absence means unavailable. */
	sendState?: string | null;
	/** Provider delivery state when the message is available. Absence never means delivered. */
	deliveryState?: string | null;
};

/**
 * Where a reviewed command stands, as this admin knows it.
 * - `reviewed`: previewed under a minted key; no attempt is known to have reached commerce.
 * - `attempted`: a send was submitted; its response has not (yet) been classified.
 * - `unknown`: commerce answered UNKNOWN, or the outcome was ambiguous. Only reconciliation with
 *   the identical command may resolve it.
 * - `rejected`: a definitive refusal; nothing is unresolved under this key.
 * - `reconciliation_required`: commerce cannot reconstruct the original send. Stop.
 */
export type FinancialEmailDraftState =
	'reviewed' | 'attempted' | 'unknown' | 'rejected' | 'reconciliation_required';

/** The browser's view of the server-held recovery record. Never the key or review token. */
export type FinancialEmailDraft = {
	/** Public identity of this review, so a stale tab cannot send another tab's command. */
	reviewId: string;
	intent: Omit<FinancialEmailIntent, 'message'>;
	/** The exact reviewed message; empty means the default greeting. */
	message: string;
	expectation: ReplyExpectation;
	reviewedAt: string;
	state: FinancialEmailDraftState;
	/** The last refusal code, when one explains the state. */
	code?: string;
	sendId?: string;
	/** Commerce history shows a command matching this review, so its send may already exist. */
	possiblyAttempted?: boolean;
};

/** Why the lifecycle's email cannot be prepared from the current projection. */
export type FinancialEmailUnavailable =
	| 'no_balance'
	| 'credit'
	| 'not_current'
	| 'revision_unavailable'
	| 'currency'
	| 'conversation'
	| 'unresolved'
	| 'storage';

export type FinancialEmailView = {
	kind: FinancialEmailKind;
	/** All five permissions; the server still enforces every one. */
	canManage: boolean;
	/** The current reviewed identity when the projection is eligible. */
	intent: Omit<FinancialEmailIntent, 'message'> | null;
	unavailable?: FinancialEmailUnavailable;
	draft: FinancialEmailDraft | null;
	/** The reviewed preview, re-read for an open panel when its token is unchanged. */
	preview: FinancialEmailPreview | null;
	/** The reviewed email no longer matches current state and needs a fresh preview. */
	stale: boolean;
	/** An unresolved command exists and this browser holds no original to reconcile it with. */
	lost: boolean;
	/** One-time outcome of the last accepted send, shown once after its redirect. */
	accepted?: { sendId: string; replayed: boolean; kind: FinancialEmailKind };
	error?: string;
};

export type FinancialEmailActionResult = {
	financialEmail: {
		draft?: FinancialEmailDraft | null;
		preview?: FinancialEmailPreview | null;
		error?: string;
		/** The staff member's unsent message, kept when it could not be reviewed. */
		message?: string;
		lost?: boolean;
		stale?: boolean;
		/** Enhanced sends only: accepted (201) or a confirmed replay (200). Native sends PRG instead. */
		accepted?: { sendId: string; replayed: boolean; kind: FinancialEmailKind };
	};
};
