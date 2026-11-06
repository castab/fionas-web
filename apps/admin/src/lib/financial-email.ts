import type { ReplyExpectation } from './conversation-contract.js';
import {
	FINANCIAL_EMAIL_PERMISSIONS,
	type FinancialEmailDraft,
	type FinancialEmailHistory,
	type FinancialEmailIntent,
	type FinancialEmailKind,
	type FinancialEmailPreview,
	type FinancialEmailSendResponse,
	type FinancialEmailUnavailable
} from './financial-email-contract.js';
import type { CurrentStaffRequest, FinancialDocumentResponse } from './request-contract.js';
import { receivedTimeLabel } from './payments.js';

/*
 * Client-safe financial-email rules: target resolution from the authoritative staff request,
 * message normalization matching commerce's `FinancialEmailMessage`, response validation, Activity
 * status derivation and staff copy. Commerce remains the authority for every eligibility decision.
 */

export const MESSAGE_MAX_LENGTH = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const TOKEN = /^[a-f0-9]{64}$/;

export const hasFinancialEmailPermissions = (permissions: readonly string[]) =>
	FINANCIAL_EMAIL_PERMISSIONS.every((p) => permissions.includes(p));

/** The lifecycle's one email kind: QUOTED emails the Quote, SERVED the balance-due Invoice. */
export function financialEmailKind(request: CurrentStaffRequest | null): FinancialEmailKind | null {
	const stage = request?.inquiry.lifecycle.stage;
	return stage === 'QUOTED' ? 'QUOTE' : stage === 'SERVED' ? 'INVOICE' : null;
}

const revision = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const positive = (value: string) =>
	DECIMAL.test(value) && !value.startsWith('-') && /[1-9]/.test(value);
const negative = (value: string) =>
	DECIMAL.test(value) && value.startsWith('-') && /[1-9]/.test(value);

/**
 * The exact identities a preview and send carry, read from the current staff request only: the
 * canonical `financial.id`, ledger `financial.version`, the business revision, and for a Quote the
 * latest proposal and its deposit revision. Never inferred from history length or the ledger.
 */
export function financialEmailTarget(
	request: CurrentStaffRequest | null
):
	| { kind: FinancialEmailKind; intent: Omit<FinancialEmailIntent, 'message'> }
	| { kind: FinancialEmailKind; unavailable: FinancialEmailUnavailable }
	| null {
	const kind = financialEmailKind(request);
	if (!request || !kind) return null;
	const { financial, proposal, depositRequirement: deposit } = request;
	if (financial.currency !== 'USD') return { kind, unavailable: 'currency' };
	if (kind === 'QUOTE') {
		if (
			financial.stage !== 'QUOTE' ||
			!proposal ||
			proposal.documentId !== financial.id ||
			proposal.documentVersion !== financial.version ||
			deposit.state !== 'ACTIVE' ||
			deposit.revision !== proposal.depositRequirementRevision
		)
			return { kind, unavailable: 'not_current' };
		const business = request.currentQuoteRevision;
		if (
			!revision(business) ||
			(proposal.quoteRevision != null && proposal.quoteRevision !== business)
		)
			return { kind, unavailable: 'revision_unavailable' };
		return {
			kind,
			intent: {
				kind,
				documentId: financial.id,
				expectedDocumentVersion: financial.version,
				expectedBusinessRevision: business,
				proposalId: proposal.id,
				expectedDepositRequirementRevision: proposal.depositRequirementRevision
			}
		};
	}
	if (financial.stage !== 'INVOICE') return { kind, unavailable: 'not_current' };
	if (!revision(request.currentInvoiceRevision))
		return { kind, unavailable: 'revision_unavailable' };
	const balance = financial.reconciliation.balance;
	if (negative(balance)) return { kind, unavailable: 'credit' };
	if (!positive(balance)) return { kind, unavailable: 'no_balance' };
	return {
		kind,
		intent: {
			kind,
			documentId: financial.id,
			expectedDocumentVersion: financial.version,
			expectedBusinessRevision: request.currentInvoiceRevision
		}
	};
}

/** Same reviewed identity: document, ledger version, business revision and Quote publication. */
export function sameIntent(
	a: Omit<FinancialEmailIntent, 'message'> | null | undefined,
	b: Omit<FinancialEmailIntent, 'message'> | null | undefined
): boolean {
	return (
		!!a &&
		!!b &&
		a.kind === b.kind &&
		a.documentId === b.documentId &&
		a.expectedDocumentVersion === b.expectedDocumentVersion &&
		a.expectedBusinessRevision === b.expectedBusinessRevision &&
		(a.proposalId ?? null) === (b.proposalId ?? null) &&
		(a.expectedDepositRequirementRevision ?? null) ===
			(b.expectedDepositRequirementRevision ?? null)
	);
}

export type MessageProblem = 'length' | 'characters';
/**
 * Commerce's `FinancialEmailMessage.ofOptional`: trimmed at the edges, at most 2,000 UTF-16 units,
 * well-formed Unicode with no controls except tab/CR/LF. Native forms send CRLF and enhanced ones
 * LF; both normalize to LF so one message has one fingerprint. Blank means the default greeting.
 */
export function financialEmailMessage(
	value: string
): { ok: true; message: string } | { ok: false; problem: MessageProblem } {
	const message = value.replace(/\r\n?/g, '\n').trim();
	if (message.length > MESSAGE_MAX_LENGTH) return { ok: false, problem: 'length' };
	if (
		// eslint-disable-next-line no-control-regex -- mirrors the backend's isISOControl check
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(message) ||
		/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(message)
	)
		return { ok: false, problem: 'characters' };
	return { ok: true, message };
}

export const messageProblemCopy: Record<MessageProblem, string> = {
	length: `Keep the personal message to ${MESSAGE_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`,
	characters: 'The personal message can only contain plain text, line breaks and tabs.'
};

/** The preview/send `email` body: the reviewed identity plus a non-blank message. */
export function intentWithMessage(
	intent: Omit<FinancialEmailIntent, 'message'>,
	message: string
): FinancialEmailIntent {
	const body: FinancialEmailIntent = {
		kind: intent.kind,
		documentId: intent.documentId,
		expectedDocumentVersion: intent.expectedDocumentVersion,
		expectedBusinessRevision: intent.expectedBusinessRevision
	};
	if (intent.kind === 'QUOTE') {
		body.proposalId = intent.proposalId;
		body.expectedDepositRequirementRevision = intent.expectedDepositRequirementRevision;
	}
	if (message) body.message = message;
	return body;
}

const object = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const money = (v: unknown): v is string => str(v) && DECIMAL.test(v);
const instant = (v: unknown) =>
	str(v) && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const optionalUuid = (v: unknown) => v == null || (str(v) && UUID.test(v));
const optionalState = (v: unknown) => v == null || (str(v) && /^[a-z_]{1,40}$/.test(v));

/** The preview answers exactly the reviewed identity, with exact money and an inert body. */
export function isFinancialEmailPreview(
	v: unknown,
	intent: Omit<FinancialEmailIntent, 'message'>,
	inquiryId: string
): v is FinancialEmailPreview {
	if (!object(v) || !object(v.financial)) return false;
	const financial = v.financial as FinancialDocumentResponse;
	return (
		v.kind === intent.kind &&
		str(v.recipientName) &&
		str(v.recipientAddress) &&
		v.recipientAddress.includes('@') &&
		str(v.subject) &&
		v.subject.length > 0 &&
		str(v.html) &&
		str(v.text) &&
		financial.id === intent.documentId &&
		financial.version === intent.expectedDocumentVersion &&
		financial.inquiryId === inquiryId &&
		financial.currency === 'USD' &&
		money(financial.total) &&
		Array.isArray(financial.lines) &&
		v.businessRevision === intent.expectedBusinessRevision &&
		money(v.requiredPayment) &&
		money(v.paidAmount) &&
		money(v.balance) &&
		(intent.kind === 'QUOTE' ? money(v.balanceAfterDeposit) : v.balanceAfterDeposit == null) &&
		str(v.reviewToken) &&
		TOKEN.test(v.reviewToken)
	);
}

/** 201/200 ACCEPTED (with replay matching the status) or 202 UNKNOWN; anything else is ambiguous. */
export function isFinancialEmailSendResponse(
	v: unknown,
	status: number | undefined
): v is FinancialEmailSendResponse {
	return (
		object(v) &&
		str(v.sendId) &&
		UUID.test(v.sendId) &&
		typeof v.replayed === 'boolean' &&
		optionalUuid(v.conversationId) &&
		optionalUuid(v.messageId) &&
		optionalState(v.sendState) &&
		((status === 202 && v.outcome === 'UNKNOWN') ||
			(status === 201 && v.outcome === 'ACCEPTED' && v.replayed === false) ||
			(status === 200 && v.outcome === 'ACCEPTED' && v.replayed === true))
	);
}

/** One timeline `financialEmails` entry (or a MESSAGE's `financialEmail`). */
export function isFinancialEmailHistory(v: unknown): v is FinancialEmailHistory {
	return (
		object(v) &&
		str(v.sendId) &&
		UUID.test(v.sendId) &&
		(v.kind === 'QUOTE' || v.kind === 'INVOICE') &&
		str(v.documentId) &&
		UUID.test(v.documentId) &&
		revision(v.documentVersion) &&
		revision(v.businessRevision) &&
		(v.kind === 'QUOTE' ? str(v.proposalId) && UUID.test(v.proposalId) : v.proposalId == null) &&
		typeof v.current === 'boolean' &&
		['ACCEPTED', 'REJECTED', 'UNKNOWN'].includes(String(v.outcome)) &&
		instant(v.requestedAt) &&
		(v.acceptedAt == null || instant(v.acceptedAt)) &&
		(v.outcome === 'ACCEPTED' || v.acceptedAt == null) &&
		object(v.actor) &&
		v.actor.principalKind === 'USER' &&
		str(v.actor.principalId) &&
		v.actor.principalId.length > 0 &&
		optionalUuid(v.conversationId) &&
		optionalUuid(v.messageId) &&
		optionalState(v.sendState) &&
		optionalState(v.deliveryState)
	);
}

export type FinancialEmailStatus = {
	kind: FinancialEmailKind;
	/** never: no accepted or unknown command; current: the current document was accepted; earlier:
	 *  only an earlier document was accepted; unknown: only unresolved commands exist. */
	summary: 'never' | 'current' | 'earlier' | 'unknown';
	/** Latest ACCEPTED command commerce marks current. */
	current?: FinancialEmailHistory;
	/** Latest ACCEPTED command of any version. */
	latest?: FinancialEmailHistory;
	/** Every UNKNOWN command: each needs exact-command reconciliation. */
	unknown: FinancialEmailHistory[];
	/** The most recent command, when it was definitively rejected. */
	rejected?: FinancialEmailHistory;
};

const byRequested = (a: FinancialEmailHistory, b: FinancialEmailHistory) =>
	Date.parse(a.requestedAt) - Date.parse(b.requestedAt);

/**
 * Status from commerce history only: `current` is commerce's comparison (business revision,
 * ledger version and proposal), never timestamps or ledger versions alone.
 */
export function financialEmailStatus(
	history: readonly FinancialEmailHistory[] | undefined,
	kind: FinancialEmailKind
): FinancialEmailStatus {
	const records = (history ?? []).filter((r) => r.kind === kind).sort(byRequested);
	const accepted = records.filter((r) => r.outcome === 'ACCEPTED');
	const current = accepted.filter((r) => r.current).at(-1);
	const latest = accepted.at(-1);
	const unknown = records.filter((r) => r.outcome === 'UNKNOWN');
	const last = records.at(-1);
	return {
		kind,
		summary: current ? 'current' : latest ? 'earlier' : unknown.length ? 'unknown' : 'never',
		current,
		latest,
		unknown,
		rejected: last?.outcome === 'REJECTED' ? last : undefined
	};
}

const sendLabels: Record<string, string> = {
	pending: 'Queued with email provider',
	accepted: 'Accepted by email provider',
	failed: 'Failed to send',
	indeterminate: 'Send status uncertain'
};
const deliveryLabels: Record<string, string> = {
	delivered: 'Delivered',
	delivery_delayed: 'Delivery delayed',
	bounced: 'Bounced',
	complained: 'Reported as spam',
	suppressed: 'Delivery suppressed',
	failed: 'Delivery failed'
};
/**
 * Provider acceptance is not delivery: only a provider delivery state says Delivered, and an
 * absent one reads "Delivery not confirmed".
 */
export function emailDeliveryLabels(record: FinancialEmailHistory): string[] {
	if (record.outcome === 'UNKNOWN') return ['Send outcome unknown'];
	if (record.outcome === 'REJECTED') return ['Rejected by email provider'];
	return [
		sendLabels[record.sendState ?? ''] ?? 'Accepted by email provider',
		deliveryLabels[record.deliveryState ?? ''] ?? 'Delivery not confirmed'
	];
}

export const kindLabel = (kind: FinancialEmailKind) => (kind === 'QUOTE' ? 'Quote' : 'Invoice');

/** The customer's first name for staff copy ("Sends the current Quote to Maya…"). */
export const customerFirstName = (name: string) => name.trim().split(/\s+/)[0] || 'the customer';

/** `receivedTimeLabel` in the business time zone, named: "Oct 20, 2026, 2:05 PM Pacific". */
export const pacificTimeLabel = (instant: string) => `${receivedTimeLabel(instant)} Pacific`;

/** Asking for the five financial-email permissions, without listing their names. */
export const missingEmailPermissionCopy =
	'Ask an administrator to turn on emailing for you. It needs access to send email and to manage payment links.';

/**
 * Staff copy for the panel and the Customer email block, built here so each sentence is one clean
 * string. `first` is the customer's first name; `when` is a `pacificTimeLabel`.
 */
export const emailCopy = {
	intro: (kind: FinancialEmailKind, first: string) =>
		kind === 'QUOTE'
			? `Sends the current Quote to ${first} in this booking’s email thread, with their payment link. Nothing goes out until you press Send quote.`
			: `Sends the current Invoice and what’s still owed to ${first} in this booking’s email thread, with their payment link. Nothing goes out until you press Send invoice.`,
	already: (kind: FinancialEmailKind, first: string, when: string) =>
		`${first} already got this ${kindLabel(kind)} on ${when}. Sending again emails them another copy.`,
	current: (kind: FinancialEmailKind, first: string, when: string, who: 'you' | 'staff') =>
		`This ${kindLabel(kind)} was emailed to ${first} ${when} by ${who}.`,
	never: (kind: FinancialEmailKind) =>
		kind === 'QUOTE'
			? 'This Quote hasn’t been emailed. Publishing it didn’t send anything.'
			: 'This Invoice hasn’t been emailed. Marking it served didn’t send anything.',
	earlier: (kind: FinancialEmailKind, label: string, when: string) =>
		`Only an earlier ${kindLabel(kind)} was emailed (${label}, ${when}). The current one hasn’t been sent.`,
	unknown: (kind: FinancialEmailKind, when: string) =>
		`We can’t tell if the ${kindLabel(kind)} email from ${when} went out.`,
	unknownNext: (checkableHere: boolean) =>
		checkableHere
			? 'You can check it again in the email panel.'
			: 'Only the original send can be checked. Don’t send another.',
	rejected: (when: string) =>
		`The last attempt (${when}) was refused by the email provider, so it wasn’t sent.`,
	lost: (sendId: string | null) =>
		`This browser doesn’t have the original email, so it can’t check it. Don’t send a new one. Ask an administrator to look into ${sendId ? `send ID ${sendId}` : 'the send ID shown under Customer email'}.`,
	footnote: (when: string, sendId: string | undefined, checkable: boolean) =>
		`Previewed ${when}${sendId ? ` · Send ID ${sendId}` : ''}.${checkable ? ' This browser keeps the previewed email for 30 days so it can be checked; check again before then.' : ''}`
};

/** The one-time notice after an accepted (201) or replayed (200) send, in the Customer email block. */
export const acceptedNoticeCopy = (kind: FinancialEmailKind, replayed: boolean) =>
	replayed
		? `This ${kindLabel(kind)} email already went out earlier, so nothing new was sent.`
		: 'Sent just now.';

/** Staff-only business revision label. Currentness comes from commerce's current flag. */
export const emailedVersionLabel = (r: { kind: FinancialEmailKind; businessRevision: number }) =>
	`${kindLabel(r.kind)} v${r.businessRevision}`;

export const intentVersionLabel = (i: Omit<FinancialEmailIntent, 'message'>) =>
	emailedVersionLabel({ kind: i.kind, businessRevision: i.expectedBusinessRevision });

export const unavailableCopy: Record<FinancialEmailUnavailable, string> = {
	no_balance: 'It’s paid in full, so there’s nothing to collect by email.',
	credit:
		'It’s overpaid, so there’s nothing to collect by email. Sort out the credit outside this workflow.',
	not_current:
		'The current published document cannot be identified from this view, so it cannot be emailed. Reload to review.',
	revision_unavailable:
		'Commerce did not report the current business revision, so this document cannot be emailed yet. Deploy the matching commerce version, then reload.',
	currency: 'Only USD documents can be emailed.',
	conversation:
		'Emailing needs a reviewable conversation (an existing thread or none yet). Check Activity, then reload.',
	unresolved:
		'An earlier financial email has an unknown outcome. Nothing else can be emailed until it is reconciled.',
	storage:
		'This browser could not keep a recovery record for the email, so it cannot be sent safely here.'
};

/** The command's original expectation, as hidden fields carried by the review form. */
export function expectationFields(expectation: ReplyExpectation): Record<string, string> {
	return expectation.expectedLatestMessageId
		? { expectedLatestMessageId: expectation.expectedLatestMessageId }
		: { expectEmptyConversation: 'true' };
}

/**
 * Staff copy for each documented refusal. Never backend diagnostics or request contents.
 * `attempted`: the command may have reached commerce (a send, not a preview).
 */
export function financialEmailError(code: string, attempted = false): string {
	const copy: Record<string, string> = {
		financial_email_review_stale:
			'The document, its recorded payments or the email changed since this preview. Preview the email again before sending.',
		financial_email_ineligible:
			'This document can’t be emailed right now: its stage changed, or its terms can’t be paid online (for example, nothing is left to collect). Reload to review the current state.',
		financial_email_deposit_required:
			'This Quote has no active approved deposit, so it cannot be emailed. Reload to review.',
		payment_access_revoked:
			'Customer payment access is revoked. Reactivate it deliberately under Customer payments, then preview the email again.',
		conversation_changed:
			'The conversation changed since you reviewed it. Check Activity, then preview the email again before sending.',
		conversation_missing:
			'The established email conversation cannot be found. It will not be replaced; ask an administrator to reconcile the provider thread.',
		financial_email_recipient_mismatch:
			'The email thread’s participant does not match this customer. Ask an administrator to reconcile the provider thread.',
		email_recipient_not_allowed:
			'This customer’s address is not on the outgoing email allow-list. An operator must review it.',
		IDEMPOTENCY_KEY_REUSED:
			'This send key already belongs to a different financial email. Do not send again; ask an administrator to recover the original command.',
		financial_email_in_progress:
			'An earlier financial email for this request has an unknown outcome. It must be reconciled with its original command before another can be sent.',
		financial_email_reconciliation_required:
			'We couldn’t confirm whether this email went out, and it can’t be sent again automatically. Ask an administrator to check its send ID before doing anything else.',
		email_send_rejected:
			'The email provider refused this email, so nothing went out. Preview again to start a new one.',
		email_sending_disabled: 'Outgoing email is not enabled. The reviewed email has been kept.',
		email_provider_unavailable:
			'The email service could not be reached. The reviewed email has been kept; try again shortly.',
		stripe_disabled:
			'Customer payments are not enabled, so financial emails are unavailable. The reviewed email has been kept.',
		financial_email_tracking_not_verified:
			'Financial emails are disabled until an operator verifies that link tracking is off for the sender domain and sets FIONAS_FINANCIAL_EMAIL_LINKS_UNTRACKED=true on commerce. Ordinary replies still work.',
		validation_failed:
			'Commerce refused the email details. Reload, check the message, then preview again.',
		malformed_request: 'The email request was refused as malformed. Reload, then preview again.',
		not_found: 'This request no longer exists. Reload the page.',
		forbidden: missingEmailPermissionCopy,
		unauthenticated: 'Your session ended. Sign in again; the reviewed email has been kept.'
	};
	if (Object.hasOwn(copy, code)) return copy[code];
	return attempted
		? 'We can’t tell if this email went out. Use Check again: it repeats the original send exactly and never sends a second copy.'
		: 'The email preview is unavailable right now. Try again shortly.';
}

/** Whether a draft's send may already exist, so it is locked to exact reconciliation. */
export const draftLocked = (draft: FinancialEmailDraft | null | undefined) =>
	!!draft &&
	(draft.state === 'attempted' ||
		draft.state === 'unknown' ||
		draft.state === 'reconciliation_required' ||
		!!draft.possiblyAttempted);
