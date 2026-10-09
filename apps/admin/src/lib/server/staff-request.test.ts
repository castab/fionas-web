import { describe, expect, it, vi } from 'vitest';
import {
	getStaffRequest,
	issueInquiryProposal,
	previewInquiryQuote,
	markInquiryServed,
	closeInquiry
} from './staff-request.js';
import type { BackendConfig } from './backend.js';
import { mayaId, requestFixtures } from '../../../e2e/request-fixture.mjs';

const projection = requestFixtures()[mayaId];
const config = (fetch: BackendConfig['fetch']): BackendConfig => ({
	baseUrl: 'http://api.test',
	origin: 'https://admin.test',
	fetch
});

describe('staff request clients', () => {
	for (const [operation, invoke] of [
		['served', markInquiryServed],
		['close', closeInquiry]
	] as const) {
		it(`posts ${operation} once with no body and forwards USER/Origin/cookies`, async () => {
			const fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ stage: 'SERVED' }), {
						headers: { 'set-cookie': 'session=renewed; Path=/' }
					})
			);
			expect(await invoke(config(fetch), 'inquiry/identity', 'session=staff')).toMatchObject({
				ok: true,
				setCookies: ['session=renewed; Path=/']
			});
			expect(fetch).toHaveBeenCalledExactlyOnceWith(
				`http://api.test/inquiries/inquiry%2Fidentity/${operation}`,
				expect.objectContaining({
					method: 'POST',
					body: undefined,
					headers: {
						accept: 'application/json',
						origin: 'https://admin.test',
						cookie: 'session=staff'
					}
				})
			);
		});
		it.each([401, 403, 404, 409, 500, 503, 'network', 'timeout'])(
			`${operation} preserves %s failure without retry`,
			async (status) => {
				const fetch = vi.fn(async () => {
					if (typeof status === 'string')
						throw status === 'timeout'
							? new DOMException('PRIVATE', 'TimeoutError')
							: new TypeError('PRIVATE');
					return new Response(JSON.stringify({ message: 'PRIVATE' }), { status });
				});
				expect(await invoke(config(fetch), mayaId, 'session=staff')).toMatchObject({
					ok: false,
					error: { status: typeof status === 'string' ? 503 : status }
				});
				expect(fetch).toHaveBeenCalledOnce();
			}
		);
	}
	it('sends exact fixed terms and preserves mutation cookies', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ proposal: {}, financial: {}, depositRequirement: {} }), {
					headers: { 'set-cookie': 'session=renewed; Path=/' }
				})
		);
		const result = await issueInquiryProposal(
			config(fetch),
			'inquiry/identity',
			7,
			{ type: 'FIXED', amount: '125.00', currency: 'CAD' },
			'session=staff'
		);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			'http://api.test/staff/requests/inquiry%2Fidentity/proposals',
			expect.objectContaining({
				body: '{"expectedDocumentVersion":7,"terms":{"type":"FIXED","amount":"125.00","currency":"CAD"}}'
			})
		);
		expect(result).toMatchObject({ ok: true, setCookies: ['session=renewed; Path=/'] });
	});
	const recording = () => vi.fn<typeof fetch>(async () => new Response('{}'));
	const sent = (fetch: ReturnType<typeof recording>, call = 0) =>
		JSON.parse(fetch.mock.calls[call][1]!.body as string);
	it('adds the reviewed composition and its token, both together, to issuance', async () => {
		const fetch = recording();
		await issueInquiryProposal(
			config(fetch),
			mayaId,
			1,
			{ type: 'PERCENTAGE', percentage: '20' },
			'session=staff',
			{ lines: [], reviewToken: 'a'.repeat(64) }
		);
		expect(sent(fetch)).toEqual({
			expectedDocumentVersion: 1,
			terms: { type: 'PERCENTAGE', percentage: '20' },
			lines: [],
			reviewToken: 'a'.repeat(64)
		});
	});
	it('previews a composition with one POST and reads catalog choices with GETs', async () => {
		const fetch = recording();
		const body = {
			expectedDocumentVersion: 1,
			lines: [],
			terms: { type: 'PERCENTAGE' as const, percentage: '20' }
		};
		await previewInquiryQuote(config(fetch), 'inquiry/identity', body, 'session=staff');
		expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
			['http://api.test/staff/requests/inquiry%2Fidentity/quote-preview', 'POST']
		]);
		expect(sent(fetch)).toEqual(body);
	});
	it('makes one coherent request read, forwarding the USER cookie and returned cookies', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(projection), {
					headers: { 'set-cookie': 'session=renewed; Path=/' }
				})
		);
		const result = await getStaffRequest(config(fetch), mayaId, 'session=staff');
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith(
			`http://api.test/staff/requests/${mayaId}`,
			expect.objectContaining({
				method: 'GET',
				headers: {
					accept: 'application/json',
					origin: 'https://admin.test',
					cookie: 'session=staff'
				},
				body: undefined
			})
		);
		expect(result).toEqual({ ok: true, data: projection, setCookies: ['session=renewed; Path=/'] });
	});
	it('issues the exact reviewed version on the inquiry proposal endpoint', async () => {
		const quote = {
			financial: { ...projection.financial, version: 2, previousVersion: 1, stage: 'QUOTE' },
			proposal: {},
			depositRequirement: {}
		};
		const fetch = vi.fn(async () => new Response(JSON.stringify(quote)));
		expect(
			await issueInquiryProposal(
				config(fetch),
				mayaId,
				1,
				{ type: 'PERCENTAGE', percentage: '20' },
				'session=staff'
			)
		).toEqual({
			ok: true,
			data: quote,
			setCookies: []
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith(
			`http://api.test/staff/requests/${mayaId}/proposals`,
			expect.objectContaining({
				method: 'POST',
				headers: {
					accept: 'application/json',
					origin: 'https://admin.test',
					cookie: 'session=staff',
					'content-type': 'application/json'
				},
				body: '{"expectedDocumentVersion":1,"terms":{"type":"PERCENTAGE","percentage":"20"}}'
			})
		);
	});
	it.each([401, 403, 404, 409, 500, 503])(
		'preserves %i failures without retries',
		async (status) => {
			const fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ code: 'conflict', message: 'PRIVATE diagnostic' }), {
						status
					})
			);
			for (const invoke of [
				() => getStaffRequest(config(fetch), mayaId, 'session=staff'),
				() =>
					issueInquiryProposal(
						config(fetch),
						mayaId,
						1,
						{ type: 'PERCENTAGE', percentage: '20' },
						'session=staff'
					)
			]) {
				fetch.mockClear();
				expect(await invoke()).toMatchObject({ ok: false, error: { status, code: 'conflict' } });
				expect(fetch).toHaveBeenCalledOnce();
			}
		}
	);
	it('maps network failures to unavailable for both clients', async () => {
		const fetch = vi.fn(async () => {
			throw new TypeError('PRIVATE network diagnostic');
		});
		expect(await getStaffRequest(config(fetch), mayaId, 'session=staff')).toMatchObject({
			ok: false,
			error: { status: 503 }
		});
		expect(
			await issueInquiryProposal(
				config(fetch),
				mayaId,
				1,
				{ type: 'PERCENTAGE', percentage: '20' },
				'session=staff'
			)
		).toMatchObject({
			ok: false,
			error: { status: 503 }
		});
	});
});
