// Session-isolated stand-in for commerce's financial-email routes (fionas-commerce PR #39). Like the
// real API: all five permissions, a trusted Origin, write-free previews with inert payment links,
// an exact-key idempotent send whose UNKNOWN reserves the inquiry, and timeline history whose
// `current` compares business revision, ledger version and proposal. No email is ever sent.
import { createHash, randomUUID } from 'node:crypto';

const REQUIRED = [
	'fionas.inquiries.read',
	'commerce.financial-document.read',
	'fionas.communications.read',
	'fionas.communications.send',
	'fionas.payment-access.manage'
];
const port = Number(process.env.COMMERCE_STUB_PORT ?? 4176);
const payUrl = 'https://www.fionasicecream.example/pay/pub_e2e#secret-e2e';
/** Remote-image probe: any hit means the preview made a network request it must not. */
const pixelHits = new Map();

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive = (value) => !value.startsWith('-') && /[1-9]/.test(value);
const escape = (value) =>
	value.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);

/** Commerce's comparison, recomputed against the current staff request on every read. */
export function currentFinancialEmails(timeline, request) {
	if (!timeline?.financialEmails) return timeline;
	const isCurrent = (r) =>
		r.documentId === request.financial.id &&
		r.documentVersion === request.financial.version &&
		(r.kind === 'QUOTE'
			? request.financial.stage === 'QUOTE' &&
				r.proposalId === request.proposal?.id &&
				r.businessRevision === request.currentQuoteRevision
			: request.financial.stage === 'INVOICE' &&
				r.businessRevision === request.currentInvoiceRevision);
	for (const record of timeline.financialEmails) record.current = isCurrent(record);
	for (const item of timeline.items)
		if (item.kind === 'MESSAGE' && item.financialEmail)
			item.financialEmail = structuredClone(
				timeline.financialEmails.find((r) => r.sendId === item.financialEmail.sendId)
			);
	return timeline;
}

/** The current identity commerce would accept, or the refusal code. */
function eligibility(request, email) {
	const stage = request.inquiry.lifecycle.stage;
	const { financial, proposal, depositRequirement } = request;
	if (email.kind === 'QUOTE') {
		if (stage !== 'QUOTED' || financial.stage !== 'QUOTE') return 'financial_email_ineligible';
		if (depositRequirement.state !== 'ACTIVE') return 'financial_email_deposit_required';
		return email.documentId === financial.id &&
			email.expectedDocumentVersion === financial.version &&
			email.expectedBusinessRevision === request.currentQuoteRevision &&
			email.proposalId === proposal?.id &&
			email.expectedDepositRequirementRevision === proposal?.depositRequirementRevision
			? null
			: 'financial_email_review_stale';
	}
	if (stage !== 'SERVED' || financial.stage !== 'INVOICE') return 'financial_email_ineligible';
	if (!positive(financial.reconciliation.balance)) return 'financial_email_ineligible';
	return email.documentId === financial.id &&
		email.expectedDocumentVersion === financial.version &&
		email.expectedBusinessRevision === request.currentInvoiceRevision &&
		email.proposalId === undefined
		? null
		: 'financial_email_review_stale';
}

function render(request, email, nonce) {
	const first = request.inquiry.name.split(/\s+/)[0] || 'there';
	const quote = email.kind === 'QUOTE';
	const greeting = quote
		? `Hi ${first}, here’s your quote`
		: `Thank you, ${first} — here’s your invoice`;
	const deposit =
		request.depositRequirement.state === 'ACTIVE'
			? request.depositRequirement.requiredAmount.amount
			: '0.00';
	const required = quote ? deposit : request.financial.reconciliation.balance;
	const paid = request.financial.reconciliation.netApplied ?? '0.00';
	const message = email.message ? escape(email.message).replace(/\n/g, '<br>') : '';
	// fionas-commerce PR #41: neutral review wording, accurate in every checkout state.
	const revised = quote && (request.proposalHistory?.length ?? 0) > 1;
	const action = quote
		? revised
			? 'Review your updated quote'
			: 'Review your quote'
		: 'Review your invoice';
	const lines = request.financial.lines
		.map((line) => `<tr data-line><td>${escape(line.description)}</td><td>$${line.total}</td></tr>`)
		.join('');
	const html = `<!doctype html><html><head><meta charset="utf-8"><title>${quote ? 'Your quote' : 'Your invoice'}</title><meta http-equiv="refresh" content="5;url=https://example.invalid/payment-preview"></head><body style="font-family:sans-serif;margin:0;padding:24px;background:#fffaf0">
<img src="http://127.0.0.1:${port}/__test/pixel?n=${nonce}" alt="Fiona's Ice Cream" width="150" height="80">
<h1 style="font-size:22px">${escape(greeting)}</h1>
${message ? `<p data-message>${message}</p>` : ''}
<h2>${quote ? 'Your quote' : 'Your invoice'}</h2>
<table>${lines}</table>
<p>Total $${request.financial.total}</p>
<p>${quote ? 'Deposit' : 'Amount due'} $${required}</p>
<a id="pay" href="https://example.invalid/payment-preview" style="display:inline-block;padding:12px 20px;background:#5f5b40;color:#fff">${action}</a>
<a id="self" target="_self" href="https://example.invalid/payment-preview">Open</a>
<script>document.body.dataset.scripted = 'yes'; parent.postMessage('escaped', '*');</script>
</body></html>`;
	const text = `${greeting}\n\n${email.message ? `${email.message}\n\n` : ''}${quote ? 'Your quote' : 'Your invoice'}\nTotal $${request.financial.total}\n\n${action}: https://example.invalid/payment-preview`;
	return {
		html,
		text,
		required,
		paid,
		balance: request.financial.reconciliation.balance,
		afterDeposit: quote ? (Number(request.financial.total) - Number(deposit)).toFixed(2) : undefined
	};
}

const reviewToken = (request, email) =>
	digest([
		email,
		request.financial.version,
		request.currentQuoteRevision,
		request.currentInvoiceRevision,
		request.financial.reconciliation,
		request.depositRequirement
	]);

export async function financialEmailRoute(
	req,
	res,
	session,
	pathname,
	send,
	readJson,
	trustedOrigin
) {
	if (pathname === '/__test/pixel') {
		const nonce = new URL(req.url ?? '/', 'http://stub').searchParams.get('n');
		pixelHits.set(nonce, (pixelHits.get(nonce) ?? 0) + 1);
		res.writeHead(204);
		res.end();
		return true;
	}
	if (pathname === '/__test/financial-email') {
		if (!session) {
			send(res, 401);
			return true;
		}
		session.financialEmail ??= {
			mode: 'accepted',
			previews: [],
			sends: [],
			records: {},
			nonce: randomUUID()
		};
		const state = session.financialEmail;
		if (req.method === 'POST') {
			const update = await readJson(req);
			if (update.mode) state.mode = update.mode;
			if (update.previewMode !== undefined) state.previewMode = update.previewMode;
			send(res, 204);
		} else send(res, 200, { ...state, pixelHits: pixelHits.get(state.nonce) ?? 0 });
		return true;
	}
	const match = /^\/staff\/requests\/([^/]+)\/financial-emails(\/preview)?$/.exec(pathname);
	if (!match) return false;
	if (!session) {
		send(res, 401);
		return true;
	}
	const [, inquiryId, previewing] = match;
	const error = (status, code) =>
		send(
			res,
			status,
			{ code, message: 'PRIVATE financial email diagnostic' },
			{ 'cache-control': 'no-store' }
		);
	if (req.method !== 'POST' || req.headers.origin !== trustedOrigin) {
		error(403, 'forbidden');
		return true;
	}
	session.financialEmail ??= {
		mode: 'accepted',
		previews: [],
		sends: [],
		records: {},
		nonce: randomUUID()
	};
	const state = session.financialEmail;
	const body = await readJson(req);
	const request = session.requests[inquiryId];
	const conversation = session.conversations?.[inquiryId];
	if (!REQUIRED.every((p) => session.permissions.includes(p))) {
		(previewing ? state.previews : state.sends).push({ refused: 'forbidden', body });
		error(403, 'forbidden');
		return true;
	}
	if (!request || !conversation) {
		error(404, 'not_found');
		return true;
	}
	const timeline = conversation.timeline;
	timeline.financialEmails ??= [];
	if (previewing) {
		state.previews.push(body);
		if (state.previewMode) {
			error(503, state.previewMode);
			return true;
		}
		const refused = eligibility(request, body);
		if (refused) {
			error(409, refused);
			return true;
		}
		if (
			typeof body.message === 'string' &&
			(body.message.length > 2000 || body.message !== body.message.trim())
		) {
			error(422, 'validation_failed');
			return true;
		}
		const rendered = render(request, body, state.nonce);
		send(
			res,
			200,
			{
				kind: body.kind,
				recipientName: request.inquiry.name,
				recipientAddress: request.inquiry.email,
				subject:
					timeline.conversation.subject ??
					(body.kind === 'QUOTE'
						? "Your quote from Fiona's Ice Cream"
						: "Your invoice from Fiona's Ice Cream"),
				html: rendered.html,
				text: rendered.text,
				financial: request.financial,
				businessRevision: body.expectedBusinessRevision,
				requiredPayment: rendered.required,
				paidAmount: rendered.paid,
				balance: rendered.balance,
				...(rendered.afterDeposit && { balanceAfterDeposit: rendered.afterDeposit }),
				reviewToken: reviewToken(request, body)
			},
			{ 'cache-control': 'no-store' }
		);
		return true;
	}
	const key = req.headers['idempotency-key'];
	state.sends.push({ key, body });
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(key ?? '')) {
		error(400, 'malformed_request');
		return true;
	}
	if (
		!!body?.expectedLatestMessageId === !!body?.expectEmptyConversation ||
		!/^[a-f0-9]{64}$/.test(body?.reviewToken ?? '')
	) {
		error(422, 'validation_failed');
		return true;
	}
	const fingerprint = digest(body);
	const existing = state.records[key];
	const accept = (record) => {
		const messageId = randomUUID();
		Object.assign(record, {
			outcome: 'ACCEPTED',
			acceptedAt: new Date().toISOString(),
			messageId,
			conversationId: '72000000-0000-0000-0000-000000000001',
			sendState: 'accepted'
		});
		const greeting = body.email.kind === 'QUOTE' ? 'here’s your quote' : 'here’s your invoice';
		timeline.items.push({
			kind: 'MESSAGE',
			id: `message:${messageId}`,
			messageId,
			occurredAt: record.acceptedAt,
			direction: 'outbound',
			senderAddress: 'bookings@fionas.example',
			senderName: 'Fiona’s Ice Cream',
			recipient: request.inquiry.email,
			text: `Hi ${request.inquiry.name.split(' ')[0]}, ${greeting}\n\n${body.email.message ? `${body.email.message}\n\n` : ''}Pay here: ${payUrl}`,
			textVisibility: 'READABLE',
			textOmittedForPaymentSecurity: false,
			sendState: 'accepted',
			deliveryState: 'unknown',
			financialEmail: structuredClone(record)
		});
		// A financial email never acknowledges customer correspondence.
		timeline.conversation = {
			...timeline.conversation,
			state: 'READY',
			latestMessageId: messageId
		};
		state.dispatched = (state.dispatched ?? 0) + 1;
	};
	const reply = (status, record) =>
		send(
			res,
			status,
			{
				sendId: record.sendId,
				outcome: record.outcome,
				replayed: status === 200,
				...(record.messageId && {
					messageId: record.messageId,
					conversationId: record.conversationId
				}),
				sendState: record.outcome === 'UNKNOWN' ? 'indeterminate' : record.sendState
			},
			{ 'cache-control': 'no-store' }
		);
	if (existing) {
		if (existing.fingerprint !== fingerprint) {
			error(409, 'IDEMPOTENCY_KEY_REUSED');
			return true;
		}
		const record = timeline.financialEmails.find((r) => r.sendId === existing.sendId);
		if (record.outcome === 'ACCEPTED') reply(200, record);
		else if (record.outcome === 'REJECTED') error(502, 'email_send_rejected');
		else if (state.mode === 'unknown') reply(202, record);
		else if (state.mode === 'reconciliation_required')
			error(409, 'financial_email_reconciliation_required');
		else {
			// Recovery dispatches the exact original once; the original expectation is not rechecked.
			accept(record);
			reply(200, record);
		}
		return true;
	}
	const refused = eligibility(request, body.email);
	if (refused || reviewToken(request, body.email) !== body.reviewToken) {
		error(409, refused ?? 'financial_email_review_stale');
		return true;
	}
	if (timeline.financialEmails.some((r) => r.outcome === 'UNKNOWN')) {
		error(409, 'financial_email_in_progress');
		return true;
	}
	if ((body.expectedLatestMessageId ?? null) !== (timeline.conversation.latestMessageId ?? null)) {
		error(409, 'conversation_changed');
		return true;
	}
	if (state.mode === 'tracking') {
		error(503, 'financial_email_tracking_not_verified');
		return true;
	}
	const record = {
		sendId: randomUUID(),
		kind: body.email.kind,
		documentId: body.email.documentId,
		documentVersion: body.email.expectedDocumentVersion,
		businessRevision: body.email.expectedBusinessRevision,
		...(body.email.proposalId && { proposalId: body.email.proposalId }),
		current: true,
		outcome: 'UNKNOWN',
		requestedAt: new Date().toISOString(),
		actor: { principalKind: 'USER', principalId: '00000000-0000-0000-0000-000000000001' }
	};
	state.records[key] = { fingerprint, sendId: record.sendId };
	timeline.financialEmails.push(record);
	if (state.mode === 'reject') {
		record.outcome = 'REJECTED';
		error(502, 'email_send_rejected');
	} else if (state.mode === 'unknown' || state.mode === 'reconciliation_required')
		reply(202, record);
	else if (state.mode === 'lost') {
		// Accepted by the provider, but the response never reaches the admin.
		accept(record);
		res.socket?.destroy();
	} else {
		accept(record);
		reply(201, record);
	}
	return true;
}
