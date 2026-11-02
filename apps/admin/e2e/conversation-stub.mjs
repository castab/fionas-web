import { randomUUID } from 'node:crypto';
import { conversationFixture, actor } from './conversation-fixture.mjs';
import { mayaId } from './request-fixture.mjs';

const streams = new WeakMap();
const heldReads = new WeakMap();
function notify(state, inquiryId) {
	state.revision = (state.revision ?? 0) + 1;
	for (const res of streams.get(state) ?? [])
		res.write(
			`event:timeline.changed\nid:${state.revision}\ndata:${JSON.stringify({ inquiryId, revision: String(state.revision) })}\n\n`
		);
}
// Behavioral provider/commerce stand-in, session isolated. No real email is sent.
export async function conversationRoute(
	req,
	res,
	session,
	pathname,
	send,
	readJson,
	trustedOrigin
) {
	if (pathname === '/__test/conversation') {
		if (!session) {
			send(res, 401);
			return true;
		}
		if (req.method === 'POST') {
			const update = await readJson(req);
			const inquiryId = update.inquiryId ?? mayaId;
			session.conversations ??= {};
			let state = session.conversations[inquiryId];
			if (!state || update.reset)
				state = session.conversations[inquiryId] = {
					timeline: conversationFixture(),
					intents: {},
					attempts: [],
					acknowledgements: [],
					mode: 'accepted'
				};
			if (update.updates) state.updates = update.updates;
			if (update.authUnavailable !== undefined) session.authUnavailable = update.authUnavailable;
			if (update.holdTimeline !== undefined) state.holdTimeline = update.holdTimeline;
			if (update.releaseTimeline) {
				for (const release of heldReads.get(state) ?? []) release();
				heldReads.delete(state);
			}
			if (update.closeStream) for (const response of streams.get(state) ?? []) response.end();
			if (update.timeline) state.timeline = update.timeline;
			if (update.mode) state.mode = update.mode;
			if (update.availability) {
				state.timeline.conversation.state = update.availability;
				if (update.availability !== 'READY') {
					state.timeline.items = state.timeline.items.filter((i) => i.kind !== 'MESSAGE');
					delete state.timeline.conversation.latestMessageId;
				}
			}
			if (update.inbound) {
				const messageId = randomUUID();
				state.timeline.items.push({
					kind: 'MESSAGE',
					id: `message:${messageId}`,
					messageId,
					occurredAt: new Date().toISOString(),
					direction: 'inbound',
					senderAddress: session.requests[inquiryId].inquiry.email,
					recipient: 'bookings@fionas.example',
					text: update.inbound,
					sendState: 'received'
				});
				state.timeline.conversation = {
					...state.timeline.conversation,
					state: 'READY',
					latestMessageId: messageId
				};
				state.timeline.attention = {
					needsReply: true,
					throughRecordedOrder: state.timeline.attention.throughRecordedOrder + 1,
					unacknowledgedSince: new Date().toISOString()
				};
			}
			if (update.notify) notify(state, inquiryId);
			session.requests[inquiryId].communication = structuredClone(state.timeline.attention);
			send(res, 204);
		} else send(res, 200, session.conversations ?? {});
		return true;
	}
	const match =
		/^\/staff\/requests\/([^/]+)\/(updates|timeline|conversation\/replies)$/.exec(pathname) ??
		/^\/inquiries\/([^/]+)\/(communications\/acknowledge)$/.exec(pathname);
	if (!match) return false;
	if (!session) {
		send(res, 401);
		return true;
	}
	const [, inquiryId, operation] = match;
	const state = session.conversations?.[inquiryId];
	const error = (status, code) =>
		send(res, status, { code, message: 'PRIVATE conversation diagnostic' });
	if (!state) {
		error(404, 'not_found');
		return true;
	}
	const permission = (p) => session.permissions.includes(`fionas.communications.${p}`);
	if (operation === 'updates' && req.method === 'GET') {
		state.subscriptions = (state.subscriptions ?? 0) + 1;
		if (
			![
				'fionas.inquiries.read',
				'commerce.financial-document.read',
				'fionas.communications.read'
			].every((p) => session.permissions.includes(p))
		)
			error(403, 'forbidden');
		else if (state.updates === 'gateway') {
			res.writeHead(503, { 'content-type': 'text/html' });
			res.end('<html>PRIVATE gateway outage</html>');
		} else if (state.updates === 'temporary') error(503, 'unavailable');
		else if (['401', '403', '404'].includes(state.updates)) error(Number(state.updates), 'refused');
		else if (!['live', 'silent'].includes(state.updates))
			error(503, 'timeline_updates_unavailable');
		else {
			if (req.headers.accept !== 'text/event-stream' || req.headers.origin !== trustedOrigin) {
				error(400, 'bad_headers');
				return true;
			}
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-store, no-transform'
			});
			res.flushHeaders();
			res.write('retry:3000\n\n');
			const active = streams.get(state) ?? new Set();
			streams.set(state, active);
			active.add(res);
			state.activeStreams = active.size;
			res.on('close', () => {
				active.delete(res);
				state.activeStreams = active.size;
			});
			if (state.updates === 'live')
				res.write(
					`event:timeline.changed\nid:0\ndata:${JSON.stringify({ inquiryId, revision: '0' })}\n\n`
				);
		}
		return true;
	}
	if (operation === 'timeline' && req.method === 'GET') {
		state.timelineReads = (state.timelineReads ?? 0) + 1;
		const snapshot = structuredClone(state.timeline);
		if (state.holdTimeline) {
			const held = heldReads.get(state) ?? [];
			heldReads.set(state, held);
			await new Promise((resolve) => held.push(resolve));
		}
		if (state.mode === 'timeline-error') error(503, 'unavailable');
		else if (state.mode === 'malformed')
			send(res, 200, { ...state.timeline, items: [{ kind: 'NEW_UNKNOWN_KIND' }] });
		else {
			const timeline = snapshot;
			if (!permission('read')) {
				timeline.conversation = { state: 'FORBIDDEN' };
				timeline.items = timeline.items.filter((i) => i.kind !== 'MESSAGE');
			}
			send(res, 200, timeline);
		}
		return true;
	}
	if (req.method !== 'POST' || req.headers.origin !== trustedOrigin) {
		error(403, 'forbidden');
		return true;
	}
	const body = await readJson(req);
	if (operation === 'communications/acknowledge') {
		state.acknowledgements.push(body);
		if (!permission('acknowledge')) error(403, 'forbidden');
		else if (body.throughRecordedOrder !== state.timeline.attention.throughRecordedOrder)
			error(409, 'conversation_changed');
		else {
			const occurredAt = new Date().toISOString();
			state.timeline.attention = {
				needsReply: false,
				throughRecordedOrder: body.throughRecordedOrder + 1,
				lastAcknowledged: { ...actor, occurredAt }
			};
			state.timeline.items.push({
				kind: 'COMMUNICATION_ACKNOWLEDGED',
				id: randomUUID(),
				occurredAt,
				actor
			});
			session.requests[inquiryId].communication = structuredClone(state.timeline.attention);
			send(res, 204);
		}
		return true;
	}
	const key = req.headers['idempotency-key'];
	state.attempts.push({ key, body });
	if (!permission('send')) {
		error(403, 'forbidden');
		return true;
	}
	if (
		!/^[A-Za-z0-9_-]{1,128}$/.test(key ?? '') ||
		!body?.body?.trim() ||
		body.body.trim().length > 5000 ||
		!!body.expectedLatestMessageId === !!body.expectEmptyConversation
	) {
		error(422, 'validation_failed');
		return true;
	}
	const fingerprint = JSON.stringify(body);
	const old = state.intents[key];
	if (old && old.fingerprint !== fingerprint) {
		error(409, 'IDEMPOTENCY_KEY_REUSED');
		return true;
	}
	if (old?.response) {
		send(res, 200, { ...old.response, replayed: true });
		return true;
	}
	if (!old) {
		if (state.timeline.conversation.state === 'MISSING') {
			error(409, 'conversation_missing');
			return true;
		}
		if (body.expectedLatestMessageId !== state.timeline.conversation.latestMessageId) {
			error(409, 'conversation_changed');
			return true;
		}
		if (state.mode.startsWith('email_')) {
			error(state.mode === 'email_send_rejected' ? 502 : 503, state.mode);
			return true;
		}
		state.intents[key] = { fingerprint, observed: state.timeline.attention.throughRecordedOrder };
	}
	if (state.mode === 'unknown') {
		send(res, 202, { outcome: 'UNKNOWN', replayed: !!old });
		return true;
	}
	const messageId = randomUUID();
	const response = {
		outcome: 'ACCEPTED',
		replayed: !!old,
		messageId,
		conversationId: '72000000-0000-0000-0000-000000000001',
		sendState: 'accepted'
	};
	state.intents[key].response = response;
	state.timeline.items.push({
		kind: 'MESSAGE',
		id: `message:${messageId}`,
		messageId,
		occurredAt: new Date().toISOString(),
		direction: 'outbound',
		senderAddress: 'bookings@fionas.example',
		senderName: 'Fiona’s Ice Cream',
		recipient: session.requests[inquiryId].inquiry.email,
		text: `${body.body}\n\nBrayan`,
		sendState: 'accepted',
		deliveryState: 'unknown'
	});
	state.timeline.conversation = {
		...state.timeline.conversation,
		state: 'READY',
		latestMessageId: messageId
	};
	if (state.intents[key].observed === state.timeline.attention.throughRecordedOrder)
		state.timeline.attention.needsReply = false;
	session.requests[inquiryId].communication = structuredClone(state.timeline.attention);
	send(res, old ? 200 : 201, response);
	return true;
}
