import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { applySetCookies } from './auth.js';
import { backendConfig } from './config.js';
import { getStaffTimeline } from './conversation.js';
import { getStaffRequest } from './staff-request.js';
import { previewFinancialEmail, sendFinancialEmail } from './financial-email.js';
import {
	clearRecovery,
	commandDigest,
	newRecord,
	publicDraft,
	readRecovery,
	sendPending,
	writeRecovery,
	type RecoveryRecord
} from './financial-email-recovery.js';
import { replyExpectation } from '../conversation.js';
import {
	financialEmailError,
	financialEmailMessage,
	financialEmailTarget,
	hasFinancialEmailPermissions,
	intentWithMessage,
	messageProblemCopy,
	sameIntent,
	unavailableCopy
} from '../financial-email.js';
import type {
	FinancialEmailActionResult,
	FinancialEmailHistory,
	FinancialEmailIntent,
	FinancialEmailPreview,
	FinancialEmailView
} from '../financial-email-contract.js';
import type { ReplyExpectation, StaffTimeline } from '../conversation-contract.js';
import type { CurrentStaffRequest } from '../request-contract.js';
import { isCurrentStaffRequest } from '../request-workspace.js';
import { workspaceRedirect } from '../request-list.js';

type Event = Pick<RequestEvent, 'locals' | 'cookies' | 'params' | 'request' | 'url'>;
type Result = FinancialEmailActionResult['financialEmail'];
const failure = (status: number, financialEmail: Result) => fail(status, { financialEmail });

/** Clock skew allowance between this admin and commerce when matching a record to a review. */
const SKEW_MS = 2 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const historyMatches = (r: FinancialEmailHistory, record: RecoveryRecord) =>
	r.actor.principalId === record.userId &&
	r.kind === record.email.kind &&
	r.documentId === record.email.documentId &&
	r.documentVersion === record.email.expectedDocumentVersion &&
	r.businessRevision === record.email.expectedBusinessRevision &&
	(r.proposalId ?? null) === (record.email.proposalId ?? null) &&
	Date.parse(r.requestedAt) >= Date.parse(record.reviewedAt) - SKEW_MS;

/**
 * A `reviewed` record whose response may have been lost: commerce history holds a command by this
 * user for the same identity requested after the review. Commerce records the intent before any
 * provider call, so without such a record nothing under this key has been dispatched.
 */
const possiblyAttempted = (record: RecoveryRecord, timeline: StaffTimeline | null) =>
	record.state === 'reviewed' &&
	!!timeline?.financialEmails?.some((r) => historyMatches(r, record));

const locked = (record: RecoveryRecord, timeline: StaffTimeline | null) =>
	record.state === 'attempted' ||
	record.state === 'unknown' ||
	record.state === 'reconciliation_required' ||
	possiblyAttempted(record, timeline);

const sameExpectation = (a: ReplyExpectation | null, b: ReplyExpectation | null) =>
	!!a &&
	!!b &&
	(a.expectedLatestMessageId ?? null) === (b.expectedLatestMessageId ?? null) &&
	!!a.expectEmptyConversation === !!b.expectEmptyConversation;

/**
 * The workspace's financial-email state: the lifecycle's eligible document, the sealed recovery
 * record (if any) and, for an open review, the re-read preview. Called only after the staff
 * request and the optional timeline load; any failure here leaves the booking visible.
 */
export async function loadFinancialEmail(
	event: Event,
	request: CurrentStaffRequest,
	timeline: StaffTimeline | null,
	open: boolean
): Promise<FinancialEmailView | null> {
	const user = event.locals.user!;
	const target = financialEmailTarget(request);
	const stored = readRecovery(event, user.id);
	let record = stored.kind === 'record' ? stored.record : null;
	let accepted: FinancialEmailView['accepted'];
	if (record?.state === 'accepted') {
		// Shown once after the PRG; the key is consumed and the private text already erased.
		accepted = { sendId: record.sendId!, replayed: !!record.replayed, kind: record.email.kind };
		clearRecovery(event);
		record = null;
	}
	const unknown = timeline?.financialEmails?.filter((r) => r.outcome === 'UNKNOWN') ?? [];
	if (record?.state === 'reconciliation_required' && timeline && unknown.length === 0) {
		// Commerce no longer reports any unresolved command (an operator resolved it).
		clearRecovery(event);
		record = null;
	}
	if (stored.kind === 'unreadable' && timeline && unknown.length === 0) clearRecovery(event);
	if (record && !target && !locked(record, timeline)) {
		// The lifecycle moved on and nothing may have been sent: the review is simply over.
		clearRecovery(event);
		record = null;
	}
	const kind = target?.kind ?? record?.email.kind;
	if (!kind) return null;
	const isLocked = !!record && locked(record, timeline);
	const intent = target && 'intent' in target ? target.intent : null;
	// UNKNOWN commands this browser cannot reconcile: by another user, or ours with no record left.
	const foreign = unknown.filter((r) => !(record && isLocked && historyMatches(r, record)));
	const lost =
		foreign.some((r) => r.actor.principalId === user.id) ||
		(stored.kind === 'unreadable' && (!timeline || unknown.length > 0));
	const conversationReady = !!replyExpectation(timeline);
	const unavailable =
		target && 'unavailable' in target
			? target.unavailable
			: foreign.length
				? ('unresolved' as const)
				: !conversationReady && !isLocked
					? ('conversation' as const)
					: undefined;
	let stale =
		!!record && !isLocked && record.state === 'reviewed' && !sameIntent(record.email, intent);
	let preview: FinancialEmailPreview | null = null;
	let error: string | undefined;
	const canManage = hasFinancialEmailPermissions(user.permissions);
	if (open && canManage && record?.state === 'reviewed' && !isLocked && !stale && intent) {
		// Write-free: shows the reviewed email again only when its token is unchanged.
		const result = await previewFinancialEmail(
			backendConfig(event.url.origin),
			event.params.inquiryId!,
			record.email,
			event.request.headers.get('cookie')
		);
		if (result.ok) {
			applySetCookies(event.cookies, result.setCookies);
			if (result.data.reviewToken === record.reviewToken) preview = result.data;
			else stale = true;
		} else {
			stale = true;
			error = financialEmailError(result.error.code);
		}
	}
	return {
		kind,
		canManage,
		intent,
		...(unavailable && { unavailable }),
		draft: record ? publicDraft(record, possiblyAttempted(record, timeline)) : null,
		preview,
		stale,
		lost,
		...(accepted && { accepted }),
		...(error && { error })
	};
}

function readIntent(form: FormData): Omit<FinancialEmailIntent, 'message'> | null {
	const one = (name: string) => {
		const values = form.getAll(name);
		return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
	};
	const int = (name: string) => {
		const raw = one(name);
		return raw && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
	};
	const kind = one('kind');
	const documentId = one('documentId');
	const version = int('expectedDocumentVersion');
	const business = int('expectedBusinessRevision');
	if ((kind !== 'QUOTE' && kind !== 'INVOICE') || !documentId || !UUID.test(documentId))
		return null;
	if (!version || !business) return null;
	if (kind === 'INVOICE')
		return form.has('proposalId') || form.has('expectedDepositRequirementRevision')
			? null
			: { kind, documentId, expectedDocumentVersion: version, expectedBusinessRevision: business };
	const proposalId = one('proposalId');
	const deposit = int('expectedDepositRequirementRevision');
	return proposalId && UUID.test(proposalId) && deposit
		? {
				kind,
				documentId,
				expectedDocumentVersion: version,
				expectedBusinessRevision: business,
				proposalId,
				expectedDepositRequirementRevision: deposit
			}
		: null;
}

function readExpectation(form: FormData): ReplyExpectation | null {
	const latest = form.getAll('expectedLatestMessageId');
	const empty = form.getAll('expectEmptyConversation');
	if (latest.length === 1 && empty.length === 0 && typeof latest[0] === 'string')
		return UUID.test(latest[0]) ? { expectedLatestMessageId: latest[0] } : null;
	return latest.length === 0 && empty.length === 1 && empty[0] === 'true'
		? { expectEmptyConversation: true }
		: null;
}

const rawMessage = (form: FormData) => {
	const values = form.getAll('message');
	return values.length <= 1 && typeof (values[0] ?? '') === 'string'
		? String(values[0] ?? '').slice(0, 4000)
		: null;
};

function authorize(event: Event) {
	const user = event.locals.user;
	if (!user) redirect(303, '/login');
	return hasFinancialEmailPermissions(user.permissions) ? user : null;
}

/**
 * Preview the current document's email. The form carries the identity and conversation the staff
 * member reviewed; either having changed is refused rather than rebased. Success mints (or, for an
 * identical command, keeps) the key and seals the complete command before anything can be sent.
 */
export async function previewFinancialEmailAction(event: Event) {
	const user = authorize(event);
	if (!user) return failure(403, { error: financialEmailError('forbidden') });
	let form: FormData;
	try {
		form = await event.request.formData();
	} catch {
		return failure(400, { error: financialEmailError('malformed_request') });
	}
	const raw = rawMessage(form);
	const posted = readIntent(form);
	const expectation = readExpectation(form);
	if (raw === null || !posted)
		return failure(400, { error: financialEmailError('malformed_request') });
	const normalized = financialEmailMessage(raw);
	if (!normalized.ok)
		return failure(422, { error: messageProblemCopy[normalized.problem], message: raw });
	const config = backendConfig(event.url.origin);
	const cookie = event.request.headers.get('cookie');
	const [current, view] = await Promise.all([
		getStaffRequest(config, event.params.inquiryId!, cookie),
		getStaffTimeline(config, event.params.inquiryId!, cookie)
	]);
	if (!current.ok && current.error.status === 401) redirect(303, '/login');
	if (!current.ok || !isCurrentStaffRequest(current.data, event.params.inquiryId!))
		return failure(503, { error: financialEmailError('unavailable'), message: raw });
	applySetCookies(event.cookies, current.setCookies);
	const stored = readRecovery(event, user.id);
	const record = stored.kind === 'record' ? stored.record : null;
	const timeline = view.ok ? view.data : null;
	if (view.ok) applySetCookies(event.cookies, view.setCookies);
	if (record && record.state !== 'accepted' && locked(record, timeline))
		return failure(409, {
			draft: publicDraft(record, possiblyAttempted(record, timeline)),
			error:
				'The reviewed email may already have been sent, so it is locked. Reconcile the original send before preparing another.'
		});
	const target = financialEmailTarget(current.data);
	if (!target || !('intent' in target))
		return failure(409, {
			error: target
				? unavailableCopy[target.unavailable]
				: financialEmailError('financial_email_ineligible'),
			message: raw
		});
	if (!sameIntent(posted, target.intent))
		return failure(409, {
			stale: true,
			message: raw,
			error:
				'The document changed since this page loaded. Reload to review the current version, then preview its email.'
		});
	if (!timeline) return failure(503, { error: unavailableCopy.conversation, message: raw });
	if (timeline.financialEmails?.some((r) => r.outcome === 'UNKNOWN'))
		return failure(409, { error: unavailableCopy.unresolved, message: raw });
	const observed = replyExpectation(timeline);
	if (!observed) return failure(409, { error: unavailableCopy.conversation, message: raw });
	if (!sameExpectation(expectation, observed))
		return failure(409, { error: financialEmailError('conversation_changed'), message: raw });
	const email = intentWithMessage(target.intent, normalized.message);
	const result = await previewFinancialEmail(config, event.params.inquiryId!, email, cookie);
	if (!result.ok) {
		if (result.error.status === 401) redirect(303, '/login');
		return failure(result.error.status >= 500 ? 503 : 409, {
			error: financialEmailError(result.error.code),
			message: raw
		});
	}
	applySetCookies(event.cookies, result.setCookies);
	// An identical command keeps its key (re-reviewing changes nothing); any change is a new one.
	const next =
		record?.state === 'reviewed' &&
		commandDigest(record.email, record.reviewToken, record.expectation) ===
			commandDigest(email, result.data.reviewToken, observed)
			? record
			: newRecord(user.id, event.params.inquiryId!, email, result.data.reviewToken, observed);
	if (!writeRecovery(event, next))
		return failure(422, { error: unavailableCopy.storage, message: raw });
	return { financialEmail: { draft: publicDraft(next), preview: result.data } satisfies Result };
}

/** Commerce refused before recording anything under this key: nothing is pending under it. */
const DEFINITIVE = new Set([
	'financial_email_review_stale',
	'financial_email_ineligible',
	'financial_email_deposit_required',
	'payment_access_revoked',
	'conversation_changed',
	'conversation_missing',
	'financial_email_recipient_mismatch',
	'email_recipient_not_allowed',
	'email_send_rejected',
	'validation_failed',
	'malformed_request'
]);
/** Refusals that change nothing about this command: it keeps the state it had. */
const RETAINED = new Set([
	'financial_email_in_progress',
	'email_sending_disabled',
	'email_provider_unavailable',
	'stripe_disabled',
	'financial_email_tracking_not_verified',
	'forbidden',
	'not_found'
]);

/**
 * Send, or reconcile, the sealed command: always its own key, email, token and original
 * expectation, never rebased onto newer correspondence. Exactly one attempt per submission.
 */
export async function sendFinancialEmailAction(event: Event) {
	const user = event.locals.user;
	if (!user) redirect(303, '/login');
	let form: FormData;
	try {
		form = await event.request.formData();
	} catch {
		return failure(400, { error: financialEmailError('malformed_request') });
	}
	const stored = readRecovery(event, user.id);
	const record = stored.kind === 'record' ? stored.record : null;
	if (!hasFinancialEmailPermissions(user.permissions))
		return failure(403, {
			draft: record ? publicDraft(record) : undefined,
			error: financialEmailError('forbidden')
		});
	if (!record)
		return failure(409, {
			lost: true,
			error:
				'The reviewed email is no longer available in this browser, so it cannot be sent or reconciled here. Check the Customer email status and Activity before doing anything else; do not prepare a new email while an earlier one may have been sent.'
		});
	if (record.state === 'accepted')
		redirect(303, workspaceRedirect(event.url) + '#financial-email-status');
	const draft = publicDraft(record);
	const reviewId = form.getAll('reviewId');
	if (reviewId.length !== 1 || reviewId[0] !== record.reviewId)
		return failure(409, {
			draft,
			error:
				'This review was replaced by a newer one, perhaps in another tab. Reload and check the email shown before sending.'
		});
	if (record.state === 'rejected' || record.state === 'reconciliation_required')
		return failure(409, {
			draft,
			error: financialEmailError(record.code ?? 'email_send_rejected')
		});
	const raw = rawMessage(form);
	const normalized = raw === null ? null : financialEmailMessage(raw);
	if (!normalized?.ok || normalized.message !== (record.email.message ?? ''))
		return failure(409, {
			draft,
			stale: record.state === 'reviewed',
			message: raw ?? undefined,
			error:
				record.state === 'reviewed'
					? 'The message changed after the preview. Preview the email again to review the new message; nothing was sent.'
					: 'The original email is locked. Reconcile repeats its exact original message.'
		});
	if (sendPending.has(record.key))
		return failure(409, {
			draft,
			error: 'This email is already being sent. Wait, then reload to review its status.'
		});
	const prior = record.state;
	// Recorded before the network call: a reload after a lost response shows a possible send.
	const attempt: RecoveryRecord = { ...record, state: prior === 'reviewed' ? 'attempted' : prior };
	writeRecovery(event, attempt);
	sendPending.add(record.key);
	let result;
	try {
		result = await sendFinancialEmail(
			backendConfig(event.url.origin),
			event.params.inquiryId!,
			record.key,
			{ email: record.email, reviewToken: record.reviewToken, ...record.expectation },
			event.request.headers.get('cookie')
		);
	} finally {
		sendPending.delete(record.key);
	}
	if (result.ok) {
		applySetCookies(event.cookies, result.setCookies);
		if (result.data.outcome === 'ACCEPTED') {
			const accepted = {
				sendId: result.data.sendId,
				replayed: result.data.replayed,
				kind: record.email.kind
			};
			// Enhanced: answer in place so Activity refreshes without discarding other drafts.
			if (event.request.headers.get('x-sveltekit-action') === 'true') {
				clearRecovery(event);
				return { financialEmail: { accepted } satisfies Result };
			}
			// Native PRG: the key is consumed; erase the private message and token, keep the notice.
			const { message: _erased, ...email } = record.email;
			void _erased;
			writeRecovery(event, {
				...record,
				email,
				reviewToken: '',
				state: 'accepted',
				sendId: result.data.sendId,
				replayed: result.data.replayed
			});
			redirect(303, workspaceRedirect(event.url) + '#financial-email-status');
		}
		const unknown: RecoveryRecord = { ...record, state: 'unknown', sendId: result.data.sendId };
		delete unknown.code;
		writeRecovery(event, unknown);
		return failure(409, {
			draft: publicDraft(unknown),
			error:
				'Commerce could not confirm whether the email was accepted. It may have been sent. Use Reconcile original send, which repeats the exact original command and cannot create a duplicate.'
		});
	}
	const code = result.error.status === 401 ? 'unauthenticated' : result.error.code;
	const next: RecoveryRecord = DEFINITIVE.has(code)
		? { ...record, state: 'rejected', code }
		: code === 'financial_email_reconciliation_required'
			? { ...record, state: 'reconciliation_required', code }
			: RETAINED.has(code) || code === 'unauthenticated'
				? { ...record, state: prior, code }
				: // Timeouts, 5xx, malformed successes, key reuse and anything unclassified.
					{ ...record, state: 'unknown', code };
	writeRecovery(event, next);
	if (code === 'unauthenticated') redirect(303, '/login');
	return failure(result.error.status === 403 ? 403 : 409, {
		draft: publicDraft(next),
		error: financialEmailError(code, next.state === 'unknown')
	});
}
