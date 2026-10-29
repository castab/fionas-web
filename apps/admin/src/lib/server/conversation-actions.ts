import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { applySetCookies } from './auth.js';
import { backendConfig } from './config.js';
import {
	acknowledgeInquiryCommunication,
	getStaffTimeline,
	sendStaffConversationReply
} from './conversation.js';
import {
	createIntent,
	findIntent,
	publicIntent,
	REPLY_COOKIE,
	REPLY_TTL_MS,
	replyBodyDigest
} from './reply-intents.js';
import { replyBody, replyError, replyExpectation } from '../conversation.js';
import { workspaceRedirect } from '../request-list.js';
import type { ReplyExpectation } from '../conversation-contract.js';

type Event = Pick<RequestEvent, 'locals' | 'cookies' | 'params' | 'request' | 'url'>;
function remember(event: Event, key: string) {
	event.cookies.set(REPLY_COOKIE, key, {
		path: `/requests/${encodeURIComponent(event.params.inquiryId!)}`,
		httpOnly: true,
		sameSite: 'strict',
		secure: event.url.protocol === 'https:',
		maxAge: 7 * 24 * 60 * 60
	});
}
export async function loadConversation(event: Event) {
	const { params, locals, cookies, request, url } = event;
	const result = await getStaffTimeline(
		backendConfig(url.origin),
		params.inquiryId!,
		request.headers.get('cookie')
	);
	if (result.ok) applySetCookies(cookies, result.setCookies);
	const timeline = result.ok ? result.data : null;
	const pointer = cookies.get(REPLY_COOKIE);
	let intent = findIntent(pointer, locals.user!.id, params.inquiryId!);
	const lost = !!pointer && !intent;
	const expectation = replyExpectation(timeline);
	if (
		(!pointer || intent?.state === 'accepted') &&
		expectation &&
		locals.user?.permissions.includes('fionas.communications.send') &&
		locals.user.permissions.includes('fionas.communications.read')
	) {
		intent = createIntent(locals.user.id, params.inquiryId!, expectation);
		if (intent) remember(event, intent.key);
	}
	return {
		timeline,
		reply:
			intent && locals.user?.permissions.includes('fionas.communications.read')
				? publicIntent(intent)
				: null,
		recoveryLost: lost,
		forbidden: !result.ok && result.error.status === 403
	};
}
export async function acknowledgeConversation(event: Event) {
	if (!event.locals.user) redirect(303, '/login');
	if (!event.locals.user.permissions.includes('fionas.communications.acknowledge'))
		return fail(403, {
			conversationError: 'You do not have permission to mark communication as read.'
		});
	const form = await event.request.formData();
	const raw = form.get('throughRecordedOrder');
	if (
		form.getAll('throughRecordedOrder').length !== 1 ||
		typeof raw !== 'string' ||
		!/^\d+$/.test(raw) ||
		!Number.isSafeInteger(Number(raw))
	)
		return fail(422, { conversationError: 'Review the conversation before marking it as read.' });
	// The submitted observation is never replaced by a fresh backend read.
	const result = await acknowledgeInquiryCommunication(
		backendConfig(event.url.origin),
		event.params.inquiryId!,
		Number(raw),
		event.request.headers.get('cookie')
	);
	if (!result.ok || result.status !== 204)
		return fail(409, {
			conversationError:
				!result.ok && result.error.code === 'conversation_changed'
					? 'New customer communication arrived. Refresh and review it before marking as read.'
					: 'Acknowledgement was not confirmed. Refresh and review before trying again.'
		});
	applySetCookies(event.cookies, result.setCookies);
	redirect(303, workspaceRedirect(event.url) + '#conversation');
}
function observedExpectation(form: FormData): ReplyExpectation | null {
	const latest = form.get('expectedLatestMessageId');
	const empty = form.get('expectEmptyConversation');
	if (
		form.getAll('expectedLatestMessageId').length > 1 ||
		form.getAll('expectEmptyConversation').length > 1
	)
		return null;
	if (
		typeof latest === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(latest) &&
		empty === null
	)
		return { expectedLatestMessageId: latest };
	return latest === null && empty === 'true' ? { expectEmptyConversation: true } : null;
}
export async function sendConversationReply(event: Event) {
	const user = event.locals.user;
	if (!user) redirect(303, '/login');
	if (
		!['fionas.communications.send', 'fionas.communications.read'].every((p) =>
			user.permissions.includes(p)
		)
	)
		return fail(403, { conversationError: replyError('forbidden') });
	const form = await event.request.formData();
	const key = form.get('key');
	let intent =
		typeof key === 'string' && form.getAll('key').length === 1
			? findIntent(key, user.id, event.params.inquiryId!)
			: null;
	if (!intent)
		return fail(409, {
			recoveryLost: true,
			conversationError:
				'The original send intent is no longer available. Review the timeline and contact an administrator to reconcile any possible send. Do not resend the message.'
		});
	if (intent.state === 'accepted') {
		const input = form.get('body');
		const normalized = typeof input === 'string' ? replyBody(input) : null;
		if (!normalized || replyBodyDigest(normalized) !== intent.bodyDigest)
			return fail(409, {
				conversationError:
					'This key already belongs to an accepted reply. Your different draft was not sent. Copy it before reloading to review the conversation.',
				reply: {
					...publicIntent(intent),
					body: typeof input === 'string' ? input.slice(0, 6000) : ''
				}
			});
		redirect(303, workspaceRedirect(event.url) + '#conversation');
	}
	if (form.get('mode') === 'review') {
		// Only a definitive non-send can become a new intent. UNKNOWN can never take this branch.
		if (intent.state !== 'rejected' && intent.state !== 'draft')
			return fail(409, {
				reply: publicIntent(intent),
				conversationError: 'Reconcile the original reply before starting another.'
			});
		const expectation = observedExpectation(form);
		if (!expectation)
			return fail(422, {
				reply: publicIntent(intent),
				conversationError: 'Refresh and review an available conversation first.'
			});
		const fresh = createIntent(user.id, event.params.inquiryId!, expectation, intent.body);
		if (!fresh)
			return fail(503, {
				reply: publicIntent(intent),
				conversationError: 'Reply preparation is temporarily unavailable.'
			});
		intent = fresh;
		remember(event, intent.key);
		return { reply: publicIntent(intent) };
	}
	if (intent.state === 'rejected')
		return fail(409, { reply: publicIntent(intent), conversationError: intent.message });
	const input = form.get('body');
	const body =
		typeof input === 'string' && form.getAll('body').length === 1 ? replyBody(input) : null;
	if (!body)
		return fail(422, {
			reply: {
				...publicIntent(intent),
				body: typeof input === 'string' ? input.slice(0, 6000) : intent.body
			},
			conversationError: replyError('validation_failed')
		});
	if (intent.state !== 'draft' && body !== intent.body)
		return fail(409, {
			reply: publicIntent(intent),
			conversationError:
				'The original reply is locked. Reconcile its unchanged content with the same key.'
		});
	if (intent.pending)
		return fail(409, {
			reply: publicIntent(intent),
			conversationError:
				'This reply is already being submitted. Wait, then refresh to review its status.'
		});
	intent.body = body;
	if (intent.state === 'draft') intent.expires = Date.now() + REPLY_TTL_MS;
	intent.bodyDigest = replyBodyDigest(body);
	intent.state = 'uncertain';
	intent.pending = true;
	intent.message = replyError('uncertain');
	let result;
	try {
		result = await sendStaffConversationReply(
			backendConfig(event.url.origin),
			event.params.inquiryId!,
			intent.key,
			{ body: intent.body, ...intent.expectation },
			event.request.headers.get('cookie')
		);
	} finally {
		intent.pending = false;
	}
	if (result.ok) {
		applySetCookies(event.cookies, result.setCookies);
		if (result.data.outcome === 'ACCEPTED') {
			intent.state = 'accepted';
			intent.body = '';
			intent.message = undefined;
			redirect(303, workspaceRedirect(event.url) + '#conversation');
		}
	} else {
		const code = result.error.code;
		intent.message = replyError(code);
		// Known pre-send refusals or durable definitive rejection only. All unexpected failures
		// (including proxy/auth responses after an earlier UNKNOWN) remain conservative.
		if (
			[
				'conversation_changed',
				'conversation_missing',
				'email_recipient_not_allowed',
				'email_send_rejected',
				'validation_failed'
			].includes(code)
		)
			intent.state = 'rejected';
	}
	return fail(409, { reply: publicIntent(intent), conversationError: intent.message });
}
