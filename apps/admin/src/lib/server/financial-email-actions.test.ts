import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	loadFinancialEmail,
	previewFinancialEmailAction,
	sendFinancialEmailAction
} from './financial-email-actions.js';
import { previewFinancialEmail, sendFinancialEmail } from './financial-email.js';
import { getStaffRequest } from './staff-request.js';
import { getStaffTimeline } from './conversation.js';
import {
	RECOVERY_COOKIE,
	readRecovery,
	seal,
	unseal,
	type RecoveryRecord
} from './financial-email-recovery.js';
import { FINANCIAL_EMAIL_PERMISSIONS } from '../financial-email-contract.js';
import type { FinancialEmailHistory, FinancialEmailPreview } from '../financial-email-contract.js';
import type { StaffTimeline } from '../conversation-contract.js';
import type { CurrentStaffRequest } from '../request-contract.js';
import { conversationFixture } from '../../../e2e/conversation-fixture.mjs';
import { mayaDocumentId, mayaId, paymentFixture } from '../../../e2e/request-fixture.mjs';

vi.mock('./financial-email.js', () => ({
	previewFinancialEmail: vi.fn(),
	sendFinancialEmail: vi.fn()
}));
vi.mock('./staff-request.js', () => ({ getStaffRequest: vi.fn() }));
vi.mock('./conversation.js', () => ({ getStaffTimeline: vi.fn() }));
vi.mock('./config.js', () => ({
	backendConfig: () => ({ baseUrl: 'https://api.test', origin: 'https://admin.test' })
}));
vi.mock('./auth.js', () => ({ applySetCookies: vi.fn() }));

const proposalId = `3${mayaId.slice(1)}`;
const token = 'a'.repeat(64);
const quote = {
	kind: 'QUOTE' as const,
	documentId: mayaDocumentId,
	expectedDocumentVersion: 2,
	expectedBusinessRevision: 2,
	proposalId,
	expectedDepositRequirementRevision: 1
};
function quoted(): CurrentStaffRequest {
	return { ...paymentFixture('quoted'), currentQuoteRevision: 2 };
}
function timeline(financialEmails: FinancialEmailHistory[] = []): StaffTimeline {
	return { ...(conversationFixture() as StaffTimeline), financialEmails };
}
const latest = () => timeline().conversation.latestMessageId!;
function preview(overrides: Partial<FinancialEmailPreview> = {}): FinancialEmailPreview {
	return {
		kind: 'QUOTE',
		recipientName: 'Maya',
		recipientAddress: 'maya@example.com',
		subject: 'Booking',
		html: '<p>Preview</p>',
		text: 'Preview',
		financial: quoted().financial,
		businessRevision: 2,
		requiredPayment: '300.00',
		paidAmount: '0.00',
		balance: '715.00',
		balanceAfterDeposit: '415.00',
		reviewToken: token,
		...overrides
	};
}
const ok = <T>(data: T, status = 200) => ({ ok: true as const, data, status, setCookies: [] });
const refusal = (status: number, code: string) => ({
	ok: false as const,
	retryAfter: null,
	error: { status, code, message: 'PRIVATE diagnostic', violations: [] }
});

/** A browser cookie jar for one inquiry path: what the server sets is what the next request carries. */
function jar() {
	const values = new Map<string, string>();
	return {
		values,
		get: (name: string) => values.get(name),
		set: vi.fn((name: string, value: string, options?: object) => {
			void options;
			values.set(name, value);
		}),
		delete: vi.fn((name: string) => void values.delete(name))
	};
}
type Jar = ReturnType<typeof jar>;
function event(
	cookies: Jar,
	fields: Record<string, string> = {},
	{ enhanced = true, user = 'me', grants = [...FINANCIAL_EMAIL_PERMISSIONS] as string[] } = {}
) {
	return {
		params: { inquiryId: mayaId },
		locals: { user: { id: user, permissions: grants } },
		cookies,
		url: new URL(`https://admin.test/requests/${mayaId}?email&from=filter%3Dquoted`),
		request: new Request(`https://admin.test/requests/${mayaId}`, {
			method: 'POST',
			headers: { cookie: 'session=staff', ...(enhanced && { 'x-sveltekit-action': 'true' }) },
			body: new URLSearchParams(fields)
		})
	} as unknown as Parameters<typeof sendFinancialEmailAction>[0];
}
const reviewFields = (message = '', expectation: Record<string, string> = {}) => ({
	kind: 'QUOTE',
	documentId: mayaDocumentId,
	expectedDocumentVersion: '2',
	expectedBusinessRevision: '2',
	proposalId,
	expectedDepositRequirementRevision: '1',
	expectedLatestMessageId: latest(),
	...expectation,
	message
});
const stored = (cookies: Jar, user = 'me') => {
	const value = readRecovery(event(cookies, {}, { user }), user);
	return value.kind === 'record' ? value.record : null;
};
async function previewed(cookies: Jar, message = 'We would love to scoop.\n\nQuestions welcome.') {
	const result = (await previewFinancialEmailAction(event(cookies, reviewFields(message)))) as {
		financialEmail: { draft: { reviewId: string } };
	};
	return result.financialEmail.draft.reviewId;
}
const sendFields = (
	reviewId: string,
	message = 'We would love to scoop.\n\nQuestions welcome.'
) => ({
	...reviewFields(message),
	reviewId
});
async function thrown(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return error as { status: number; location: string };
	}
	throw new Error('expected a redirect');
}
const sendBodies = () => vi.mocked(sendFinancialEmail).mock.calls.map((call) => call.slice(2, 4));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getStaffRequest).mockResolvedValue(ok(quoted()));
	vi.mocked(getStaffTimeline).mockResolvedValue(ok(timeline()));
	vi.mocked(previewFinancialEmail).mockResolvedValue(ok(preview()));
	vi.mocked(sendFinancialEmail).mockResolvedValue(
		ok(
			{ sendId: '40000000-0000-4000-8000-000000000001', outcome: 'ACCEPTED', replayed: false },
			201
		)
	);
});

describe('recovery sealing', () => {
	const record = (): RecoveryRecord => ({
		v: 1,
		userId: 'me',
		inquiryId: mayaId,
		key: 'key-1',
		reviewId: 'review-1',
		email: { ...quote, message: '冰淇淋'.repeat(666) },
		reviewToken: token,
		expectation: { expectEmptyConversation: true },
		reviewedAt: new Date().toISOString(),
		state: 'reviewed'
	});

	it('round-trips only for the same user and inquiry, and refuses tampering', () => {
		const sealed = seal(record());
		expect(sealed).not.toContain('冰淇淋');
		expect(unseal(sealed, mayaId, 'me')?.email.message).toBe('冰淇淋'.repeat(666));
		expect(unseal(sealed, mayaId, 'someone-else')).toBeNull();
		expect(unseal(sealed, '00000000-0000-0000-0000-000000000009', 'me')).toBeNull();
		const flipped = Buffer.from(sealed, 'base64url');
		flipped[40] ^= 1;
		expect(unseal(flipped.toString('base64url'), mayaId, 'me')).toBeNull();
	});

	it('fits a maximum-length message across bounded HttpOnly, SameSite=Strict, path-scoped chunks', async () => {
		const cookies = jar();
		// Incompressible worst case: 2,000 varied three-byte characters.
		const worst = Array.from({ length: 2000 }, (_, i) =>
			String.fromCharCode(0x4e00 + ((i * 7919) % 20000))
		).join('');
		await previewed(cookies, worst);
		const names = [...cookies.values.keys()];
		expect(names.every((n) => n.startsWith(RECOVERY_COOKIE))).toBe(true);
		expect(names.length).toBeGreaterThan(1);
		expect(names.length).toBeLessThanOrEqual(3);
		for (const [, , options] of cookies.set.mock.calls)
			expect(options).toMatchObject({
				httpOnly: true,
				sameSite: 'strict',
				secure: true,
				path: `/requests/${mayaId}`
			});
		expect(stored(cookies)?.email.message).toBe(worst);
	});
});

describe('financial email preview action', () => {
	it('previews the exact authoritative identities with the normalized message, writing no send', async () => {
		const cookies = jar();
		const result = await previewFinancialEmailAction(
			event(cookies, reviewFields('  Hi Maya!\r\n\r\nSee you soon. '))
		);
		expect(vi.mocked(previewFinancialEmail).mock.calls[0][2]).toEqual({
			...quote,
			message: 'Hi Maya!\n\nSee you soon.'
		});
		expect(sendFinancialEmail).not.toHaveBeenCalled();
		const record = stored(cookies)!;
		expect(record).toMatchObject({
			state: 'reviewed',
			reviewToken: token,
			expectation: { expectedLatestMessageId: latest() }
		});
		// The browser sees the review, never the key or token.
		expect(JSON.stringify(result)).not.toContain(record.key);
		expect(
			JSON.stringify((result as { financialEmail: { draft: unknown } }).financialEmail.draft)
		).not.toContain(token);
	});

	it('omits a blank message so commerce uses its default greeting', async () => {
		await previewFinancialEmailAction(event(jar(), reviewFields('   ')));
		expect(vi.mocked(previewFinancialEmail).mock.calls[0][2]).toEqual(quote);
	});

	it('keeps the key for an identical re-review and mints a new one for a changed message', async () => {
		const cookies = jar();
		await previewed(cookies);
		const first = stored(cookies)!.key;
		await previewed(cookies);
		expect(stored(cookies)!.key).toBe(first);
		await previewed(cookies, 'Different words');
		expect(stored(cookies)!.key).not.toBe(first);
	});

	it.each([
		['a changed Quote revision', { expectedBusinessRevision: '1' }],
		['another document version', { expectedDocumentVersion: '1' }],
		['newer correspondence', { expectedLatestMessageId: '50000000-0000-4000-8000-00000000000f' }]
	])('refuses %s without previewing', async (_, change) => {
		const cookies = jar();
		const result = (await previewFinancialEmailAction(
			event(cookies, { ...reviewFields('Kept text'), ...change })
		)) as { status: number; data: { financialEmail: { message: string } } };
		expect(result.status).toBe(409);
		expect(result.data.financialEmail.message).toBe('Kept text');
		expect(previewFinancialEmail).not.toHaveBeenCalled();
		expect(cookies.values.size).toBe(0);
	});

	it('refuses an invalid message and missing permissions before any backend call', async () => {
		const long = (await previewFinancialEmailAction(
			event(jar(), reviewFields('x'.repeat(2001)))
		)) as { status: number };
		expect(long.status).toBe(422);
		for (const missing of FINANCIAL_EMAIL_PERMISSIONS) {
			const denied = (await previewFinancialEmailAction(
				event(jar(), reviewFields(), {
					grants: FINANCIAL_EMAIL_PERMISSIONS.filter((p) => p !== missing)
				})
			)) as { status: number };
			expect(denied.status).toBe(403);
		}
		expect(getStaffRequest).not.toHaveBeenCalled();
		expect(previewFinancialEmail).not.toHaveBeenCalled();
	});

	it('refuses while any financial email has an unknown outcome', async () => {
		vi.mocked(getStaffTimeline).mockResolvedValue(
			ok(
				timeline([
					{
						sendId: '40000000-0000-4000-8000-000000000009',
						kind: 'QUOTE',
						documentId: mayaDocumentId,
						documentVersion: 2,
						businessRevision: 2,
						proposalId,
						current: true,
						outcome: 'UNKNOWN',
						requestedAt: '2026-07-17T18:00:00Z',
						actor: { principalKind: 'USER', principalId: 'someone' }
					}
				])
			)
		);
		const result = (await previewFinancialEmailAction(event(jar(), reviewFields()))) as {
			status: number;
		};
		expect(result.status).toBe(409);
		expect(previewFinancialEmail).not.toHaveBeenCalled();
	});

	it('does not offer an Invoice email that is not SERVED with a balance', async () => {
		const booked = paymentFixture('booked');
		vi.mocked(getStaffRequest).mockResolvedValue(ok({ ...booked, currentInvoiceRevision: 3 }));
		const result = (await previewFinancialEmailAction(
			event(jar(), {
				kind: 'INVOICE',
				documentId: mayaDocumentId,
				expectedDocumentVersion: '3',
				expectedBusinessRevision: '3',
				expectedLatestMessageId: latest()
			})
		)) as { status: number };
		expect(result.status).toBe(409);
		expect(previewFinancialEmail).not.toHaveBeenCalled();
	});
});

describe('financial email send action', () => {
	it('sends the sealed command once; an enhanced 201 answers in place and consumes the key', async () => {
		const cookies = jar();
		const reviewId = await previewed(cookies);
		const key = stored(cookies)!.key;
		const result = await sendFinancialEmailAction(event(cookies, sendFields(reviewId)));
		expect(result).toEqual({
			financialEmail: {
				accepted: { sendId: '40000000-0000-4000-8000-000000000001', replayed: false, kind: 'QUOTE' }
			}
		});
		expect(sendBodies()).toEqual([
			[
				key,
				{
					email: { ...quote, message: 'We would love to scoop.\n\nQuestions welcome.' },
					reviewToken: token,
					expectedLatestMessageId: latest()
				}
			]
		]);
		expect(cookies.values.size).toBe(0);
	});

	it('PRGs a native send and keeps only a body-free accepted notice', async () => {
		const cookies = jar();
		const reviewId = await previewed(cookies);
		const redirect = await thrown(
			sendFinancialEmailAction(event(cookies, sendFields(reviewId), { enhanced: false }))
		);
		expect(redirect).toMatchObject({
			status: 303,
			location: `/requests/${mayaId}?from=filter%3Dquoted#financial-email-status`
		});
		const notice = stored(cookies)!;
		expect(notice.state).toBe('accepted');
		expect(notice.email.message).toBeUndefined();
		expect(notice.reviewToken).toBe('');
		const view = await loadFinancialEmail(event(cookies), quoted(), timeline(), false);
		expect(view?.accepted).toEqual({
			sendId: '40000000-0000-4000-8000-000000000001',
			replayed: false,
			kind: 'QUOTE'
		});
		expect(cookies.values.size).toBe(0);
	});

	it('treats a 200 replay as accepted without another email', async () => {
		vi.mocked(sendFinancialEmail).mockResolvedValue(
			ok({ sendId: '40000000-0000-4000-8000-000000000001', outcome: 'ACCEPTED', replayed: true })
		);
		const cookies = jar();
		const result = await sendFinancialEmailAction(
			event(cookies, sendFields(await previewed(cookies)))
		);
		expect(result).toMatchObject({ financialEmail: { accepted: { replayed: true } } });
		expect(sendFinancialEmail).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			'202 UNKNOWN',
			ok(
				{
					sendId: '40000000-0000-4000-8000-000000000002',
					outcome: 'UNKNOWN' as const,
					replayed: false
				},
				202
			)
		],
		['a network timeout', refusal(503, 'unavailable')],
		['a malformed success', refusal(503, 'uncertain_send')],
		['an internal failure', refusal(500, 'internal_failure')],
		['a reused key', refusal(409, 'IDEMPOTENCY_KEY_REUSED')]
	])(
		'locks the exact command after %s, and reconciliation repeats it even after new mail',
		async (_, outcome) => {
			vi.mocked(sendFinancialEmail).mockResolvedValueOnce(outcome as never);
			const cookies = jar();
			const reviewId = await previewed(cookies);
			const result = (await sendFinancialEmailAction(event(cookies, sendFields(reviewId)))) as {
				status: number;
				data: { financialEmail: { draft: { state: string }; error: string } };
			};
			expect(result.status).toBe(409);
			expect(result.data.financialEmail.draft.state).toBe('unknown');
			expect(result.data.financialEmail.error).not.toContain('PRIVATE');
			// New inbound mail arrives; the original expectation is never rebased.
			vi.mocked(getStaffTimeline).mockResolvedValue(
				ok({
					...timeline(),
					conversation: {
						...timeline().conversation,
						latestMessageId: '50000000-0000-4000-8000-0000000000aa'
					}
				})
			);
			const edited = (await previewFinancialEmailAction(
				event(cookies, reviewFields('A new message'))
			)) as { status: number };
			expect(edited.status).toBe(409);
			const changed = (await sendFinancialEmailAction(
				event(cookies, sendFields(reviewId, 'A new message'))
			)) as { status: number };
			expect(changed.status).toBe(409);
			expect(sendFinancialEmail).toHaveBeenCalledTimes(1);
			await sendFinancialEmailAction(event(cookies, sendFields(reviewId)));
			expect(sendBodies()[1]).toEqual(sendBodies()[0]);
			expect(sendBodies()[1][1]).toMatchObject({ expectedLatestMessageId: latest() });
		}
	);

	it('records a definitive rejection and lets a new review mint a new key', async () => {
		vi.mocked(sendFinancialEmail).mockResolvedValueOnce(refusal(502, 'email_send_rejected'));
		const cookies = jar();
		const reviewId = await previewed(cookies);
		const first = stored(cookies)!.key;
		const result = (await sendFinancialEmailAction(event(cookies, sendFields(reviewId)))) as {
			data: { financialEmail: { draft: { state: string } } };
		};
		expect(result.data.financialEmail.draft.state).toBe('rejected');
		await previewed(cookies);
		expect(stored(cookies)).toMatchObject({ state: 'reviewed' });
		expect(stored(cookies)!.key).not.toBe(first);
	});

	it('keeps a reviewed command retryable under its own key after a configuration refusal', async () => {
		vi.mocked(sendFinancialEmail).mockResolvedValueOnce(
			refusal(503, 'financial_email_tracking_not_verified')
		);
		const cookies = jar();
		const reviewId = await previewed(cookies);
		const result = (await sendFinancialEmailAction(event(cookies, sendFields(reviewId)))) as {
			data: { financialEmail: { draft: { state: string }; error: string } };
		};
		expect(result.data.financialEmail.draft.state).toBe('reviewed');
		expect(result.data.financialEmail.error).toContain('FIONAS_FINANCIAL_EMAIL_LINKS_UNTRACKED');
		await sendFinancialEmailAction(event(cookies, sendFields(reviewId)));
		expect(sendBodies()[1]).toEqual(sendBodies()[0]);
	});

	it('stops at reconciliation required', async () => {
		vi.mocked(sendFinancialEmail).mockResolvedValueOnce(
			refusal(409, 'financial_email_reconciliation_required')
		);
		const cookies = jar();
		const reviewId = await previewed(cookies);
		await sendFinancialEmailAction(event(cookies, sendFields(reviewId)));
		const again = (await sendFinancialEmailAction(event(cookies, sendFields(reviewId)))) as {
			status: number;
		};
		expect(again.status).toBe(409);
		expect(sendFinancialEmail).toHaveBeenCalledTimes(1);
	});

	it('never sends without the original record, another tab’s review or a changed message', async () => {
		const lost = (await sendFinancialEmailAction(event(jar(), sendFields('review-x')))) as {
			data: { financialEmail: { lost: boolean } };
		};
		expect(lost.data.financialEmail.lost).toBe(true);
		const cookies = jar();
		const reviewId = await previewed(cookies);
		await sendFinancialEmailAction(event(cookies, sendFields('another-review')));
		await sendFinancialEmailAction(event(cookies, sendFields(reviewId, 'Edited after preview')));
		// Another staff member cannot use (or even read) this user's record.
		await sendFinancialEmailAction(event(cookies, sendFields(reviewId), { user: 'other' }));
		expect(sendFinancialEmail).not.toHaveBeenCalled();
	});

	it('refuses a send without all five permissions', async () => {
		const cookies = jar();
		const reviewId = await previewed(cookies);
		const result = (await sendFinancialEmailAction(
			event(cookies, sendFields(reviewId), {
				grants: FINANCIAL_EMAIL_PERMISSIONS.filter((p) => p !== 'fionas.payment-access.manage')
			})
		)) as { status: number };
		expect(result.status).toBe(403);
		expect(sendFinancialEmail).not.toHaveBeenCalled();
	});
});

describe('financial email load', () => {
	const history = (overrides: Partial<FinancialEmailHistory>): FinancialEmailHistory => ({
		sendId: '40000000-0000-4000-8000-000000000005',
		kind: 'QUOTE',
		documentId: mayaDocumentId,
		documentVersion: 2,
		businessRevision: 2,
		proposalId,
		current: true,
		outcome: 'UNKNOWN',
		requestedAt: new Date(Date.now() + 1000).toISOString(),
		actor: { principalKind: 'USER', principalId: 'me' },
		...overrides
	});

	it('locks a reviewed command when commerce shows a matching attempt after the review', async () => {
		const cookies = jar();
		await previewed(cookies);
		const view = await loadFinancialEmail(event(cookies), quoted(), timeline([history({})]), true);
		expect(view?.draft).toMatchObject({ state: 'reviewed', possiblyAttempted: true });
		expect(view?.lost).toBe(false);
		expect(view?.unavailable).toBeUndefined();
		expect(previewFinancialEmail).toHaveBeenCalledTimes(1); // no re-preview of a locked command
	});

	it('fails closed when an unknown send exists and this browser has no original', async () => {
		const view = await loadFinancialEmail(event(jar()), quoted(), timeline([history({})]), true);
		expect(view).toMatchObject({ lost: true, unavailable: 'unresolved', draft: null });
		const other = await loadFinancialEmail(
			event(jar()),
			quoted(),
			timeline([history({ actor: { principalKind: 'USER', principalId: 'someone' } })]),
			true
		);
		expect(other).toMatchObject({ lost: false, unavailable: 'unresolved' });
	});

	it('re-reads an open review and marks it stale when its token changed', async () => {
		const cookies = jar();
		await previewed(cookies);
		vi.mocked(previewFinancialEmail).mockResolvedValueOnce(
			ok(preview({ reviewToken: 'b'.repeat(64) }))
		);
		const view = await loadFinancialEmail(event(cookies), quoted(), timeline(), true);
		expect(view).toMatchObject({ stale: true, preview: null });
		const fresh = await loadFinancialEmail(event(cookies), quoted(), timeline(), true);
		expect(fresh).toMatchObject({ stale: false, preview: { reviewToken: token } });
	});

	it('marks a review stale when the Quote revision changed, and offers nothing when BOOKED', async () => {
		const cookies = jar();
		await previewed(cookies);
		const revised = { ...quoted(), currentQuoteRevision: 3 };
		expect(await loadFinancialEmail(event(cookies), revised, timeline(), false)).toMatchObject({
			stale: true
		});
		const booked = { ...paymentFixture('booked'), currentInvoiceRevision: 3 };
		expect(await loadFinancialEmail(event(cookies), booked, timeline(), false)).toBeNull();
		expect(cookies.values.size).toBe(0);
	});

	it('keeps an unknown command reconcilable even after the lifecycle moved on', async () => {
		vi.mocked(sendFinancialEmail).mockResolvedValueOnce(refusal(500, 'internal_failure'));
		const cookies = jar();
		await sendFinancialEmailAction(event(cookies, sendFields(await previewed(cookies))));
		const booked = { ...paymentFixture('booked'), currentInvoiceRevision: 3 };
		const view = await loadFinancialEmail(event(cookies), booked, timeline([history({})]), false);
		expect(view).toMatchObject({ kind: 'QUOTE', draft: { state: 'unknown' }, lost: false });
	});
});
