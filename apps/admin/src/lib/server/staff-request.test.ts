import { describe, expect, it, vi } from 'vitest';
import { getStaffRequest, issueQuote } from './staff-request.js';
import type { BackendConfig } from './backend.js';
import { mayaId, mayaDocumentId, requestFixtures } from '../../../e2e/request-fixture.mjs';

const projection = requestFixtures()[mayaId];
const config = (fetch: BackendConfig['fetch']): BackendConfig => ({
	baseUrl: 'http://api.test',
	origin: 'https://admin.test',
	fetch
});

describe('staff request clients', () => {
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
	it('issues the exact reviewed version on the existing document endpoint', async () => {
		const quote = { ...projection.financial, version: 2, previousVersion: 1, stage: 'QUOTE' };
		const fetch = vi.fn(async () => new Response(JSON.stringify(quote)));
		expect(await issueQuote(config(fetch), mayaDocumentId, 1, 'session=staff')).toEqual({
			ok: true,
			data: quote,
			setCookies: []
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith(
			`http://api.test/financial-documents/${mayaDocumentId}/quote`,
			expect.objectContaining({
				method: 'POST',
				headers: {
					accept: 'application/json',
					origin: 'https://admin.test',
					cookie: 'session=staff',
					'content-type': 'application/json'
				},
				body: '{"expectedVersion":1}'
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
				() => issueQuote(config(fetch), mayaDocumentId, 1, 'session=staff')
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
		expect(await issueQuote(config(fetch), mayaDocumentId, 1, 'session=staff')).toMatchObject({
			ok: false,
			error: { status: 503 }
		});
	});
});
