import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
	parsePriceBook,
	projectForm,
	priceInquiry,
	type PriceBook
} from '$lib/server/price-book.js';
import { prepareInquiry, answersFromFormData } from '@fionas/shared';
import { sealReplay } from './inquiry-replay.js';
import {
	fakeCommerce,
	TEST_BASE_URL,
	TEST_SERVICE_ID,
	TEST_SERVICE_CREDENTIAL
} from '$lib/server/testing/fake-commerce.js';
const state = vi.hoisted(() => ({
	env: {} as Record<string, string>,
	book: null as PriceBook | null
}));
vi.mock('$env/dynamic/private', () => ({ env: state.env }));
vi.mock('$lib/server/price-book.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/price-book.js')>()),
	getPriceBook: () => {
		if (!state.book) throw new Error('Unavailable');
		return state.book;
	}
}));
const { submitInquiry } = await import('$lib/server/inquiry-submission.js');
const { resetCommerceClient } = await import('$lib/server/commerce.js');
const { load } = await import('../../routes/book/+page.server.js');
const KEY = 'test-logical-key';
function form(): FormData {
	const f = new FormData();
	for (const [key, value] of Object.entries({
		submissionToken: KEY,
		priceRevision: 'synthetic-1',
		name: 'Jane Doe',
		email: 'jane@example.com',
		zipCode: '02134',
		eventDate: '2026-12-05',
		eventType: 'BIRTHDAY',
		guestCount: '75',
		message: 'Backyard birthday'
	}))
		f.set(key, value);
	for (const [key, values] of Object.entries({
		'offering:hand-scooped-flavor': [
			'hand-scooped-chocolate-chip',
			'hand-scooped-chocolate',
			'hand-scooped-butter-pecan',
			'hand-scooped-strawberry'
		],
		'offering:topping': ['rainbow-sprinkles', 'chocolate-sauce', 'caramel-sauce', 'crushed-oreo'],
		'offering:cone-option': ['sugar-cone']
	}))
		for (const v of values) f.append(key, v);
	return f;
}
let backend: ReturnType<typeof fakeCommerce>;
beforeEach(() => {
	Object.assign(state.env, {
		BOOKING_ENABLED: 'true',
		COMMERCE_API_URL: TEST_BASE_URL,
		COMMERCE_SERVICE_ID: TEST_SERVICE_ID,
		COMMERCE_SERVICE_CREDENTIAL: TEST_SERVICE_CREDENTIAL,
		FIONAS_REPLAY_SECRET: 'synthetic-test-only-signing-secret-32-bytes'
	});
	state.book = parsePriceBook(
		readFileSync(new URL('../../../e2e/fixtures/prices.synthetic.yaml', import.meta.url), 'utf8')
	);
	resetCommerceClient();
	backend = fakeCommerce();
	vi.stubGlobal('fetch', vi.fn(backend.fetch));
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
describe('trusted inquiry submission', () => {
	it('prices intent from the private snapshot, sends descriptive service and no totals', async () => {
		expect((await submitInquiry(form())).ok).toBe(true);
		const body = backend.posts()[0].body as Record<string, unknown>;
		expect(body).toHaveProperty('requestedService.guestCount', 75);
		expect(body).not.toHaveProperty('serviceInputs');
		expect(body).not.toHaveProperty('total');
		expect(body.lines).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ unitPrice: '101.00' }),
				expect.objectContaining({ quantity: '75', unitPrice: '7.00' })
			])
		);
	});
	it.each(['unitPrice', 'taxAmount', 'total', 'lines', 'requestedService'])(
		'ignores forged %s',
		async (key) => {
			const f = form();
			f.set(key, JSON.stringify([{ unitPrice: '0.01', description: 'Forged' }]));
			await submitInquiry(f);
			expect(JSON.stringify(backend.posts()[0].body)).not.toContain('Forged');
			expect(JSON.stringify(backend.posts()[0].body)).not.toContain('0.01');
		}
	);
	it.each([
		'name',
		'email',
		'zipCode',
		'eventDate',
		'eventType',
		'guestCount',
		'offering:hand-scooped-flavor',
		'offering:topping',
		'offering:cone-option'
	])('refuses incomplete %s', async (key) => {
		const f = form();
		f.delete(key);
		expect(await submitInquiry(f)).toMatchObject({ ok: false, status: 422 });
		expect(backend.posts()).toHaveLength(0);
	});
	it('quotes up to 300 guests online and refuses more before any delivery', async () => {
		const f = form();
		f.set('guestCount', '301');
		expect(await submitInquiry(f)).toMatchObject({
			ok: false,
			status: 422,
			failure: { errors: { guestCount: expect.stringContaining('up to 300 online') } }
		});
		expect(backend.posts()).toHaveLength(0);
		f.set('guestCount', '300');
		expect(await submitInquiry(f)).toMatchObject({ ok: true });
		expect(backend.posts()[0].body).toMatchObject({ requestedService: { guestCount: 300 } });
	});
	it('records no service duration, even when one is posted', async () => {
		const f = form();
		f.set('durationMinutes', '150');
		expect(await submitInquiry(f)).toMatchObject({ ok: true });
		const body = backend.posts()[0].body as { requestedService: object };
		expect(body.requestedService).not.toHaveProperty('durationMinutes');
		expect(JSON.stringify(body)).not.toMatch(/duration|hour/i);
	});
	it('accepts any combination of cones and cups, free, and refuses none or unknown', async () => {
		const f = form();
		f.set('offering:cone-option', 'cup');
		f.append('offering:cone-option', 'sugar-cone');
		f.append('offering:cone-option', 'cake-cone');
		expect(await submitInquiry(f)).toMatchObject({ ok: true });
		const body = backend.posts()[0].body as {
			requestedService: { items: { key: string }[] };
			lines: { description: string }[];
		};
		expect(
			body.requestedService.items.filter((i) => ['cup', 'sugar-cone', 'cake-cone'].includes(i.key))
		).toHaveLength(3);
		expect(body.lines.map((l) => l.description)).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/cone|cup/i)])
		);
		const bad = form();
		bad.append('offering:cone-option', 'waffle-cone');
		expect(await submitInquiry(bad)).toMatchObject({ ok: false, status: 422 });
	});
	it('no longer offers soft serve, even when its picks are posted', async () => {
		const f = form();
		f.append('offering:soft-serve-flavor', 'vanilla');
		f.append('offering:soft-serve-flavor', 'chocolate');
		expect(await submitInquiry(f)).toMatchObject({ ok: true });
		expect(JSON.stringify(backend.posts()[0].body)).not.toMatch(/soft.serve/i);
	});
	it('rejects unsupported and unavailable picks locally', async () => {
		for (const key of ['made-up', 'marshmallow-sauce']) {
			const f = form();
			f.append('offering:topping', key);
			expect(await submitInquiry(f), key).toMatchObject({ ok: false, status: 422 });
		}
		// Three real flavors plus the unavailable one: only availability can refuse this.
		const f = form();
		f.set('offering:hand-scooped-flavor', 'hand-scooped-chocolate-chip');
		f.append('offering:hand-scooped-flavor', 'hand-scooped-chocolate');
		f.append('offering:hand-scooped-flavor', 'hand-scooped-mint-chip');
		f.append('offering:hand-scooped-flavor', 'hand-scooped-cheesecake');
		expect(await submitInquiry(f)).toMatchObject({ ok: false, status: 422 });
		expect(backend.posts()).toHaveLength(0);
	});
	it('reviews a stale price revision before any backend POST, with a fresh key', async () => {
		const f = form();
		f.set('priceRevision', 'old');
		const result = await submitInquiry(f);
		expect(result).toMatchObject({
			ok: false,
			status: 409,
			failure: { priceRevision: 'synthetic-1', outcome: 'stale' }
		});
		expect(!result.ok && result.failure.submissionToken).not.toBe(KEY);
		expect(backend.posts()).toHaveLength(0);
	});
	it('keeps exact priced body and key across automatic retry and signed replay under changed prices', async () => {
		backend.script({ status: 500 }, { status: 500 });
		const first = await submitInquiry(form());
		if (first.ok) throw new Error('Expected unknown');
		expect(first.failure.outcome).toBe('ambiguous');
		expect(backend.posts()[0].body).toEqual(backend.posts()[1].body);
		const f = form();
		f.set('outcomeUnknown', 'true');
		f.set('replayRequest', first.failure.replay!.envelope);
		f.set('guestCount', '999');
		state.book = {
			revision: 'new-prices',
			amounts: { ...state.book!.amounts, 'event.base': '999.00' }
		};
		expect((await submitInquiry(f)).ok).toBe(true);
		expect(backend.posts()[2].body).toEqual(backend.posts()[0].body);
		expect(backend.posts().map((p) => p.headers['idempotency-key'])).toEqual([KEY, KEY, KEY]);
	});
	it.each(['altered', 'rebound', 'unsigned', 'missing'])(
		'rejects %s replay without a backend POST',
		async (mode) => {
			backend.script({ status: 500 }, { status: 500 });
			const first = await submitInquiry(form());
			if (first.ok) throw new Error('Expected unknown');
			let envelope = first.failure.replay!.envelope;
			const f = form();
			f.set('outcomeUnknown', 'true');
			if (mode === 'altered') {
				const [payload, signature] = envelope.split('.');
				const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
				expect(value.command).toContain('"101.00"');
				value.command = value.command.replace('"101.00"', '"0.01"');
				envelope = Buffer.from(JSON.stringify(value)).toString('base64url') + '.' + signature;
			}
			if (mode === 'rebound') f.set('submissionToken', 'different-key');
			if (mode === 'unsigned') envelope = JSON.stringify(backend.posts()[0].body);
			if (mode !== 'missing') f.set('replayRequest', envelope);
			expect(await submitInquiry(f)).toMatchObject({ ok: false, status: 400 });
			expect(backend.posts()).toHaveLength(2);
		}
	);
	it('fails closed with absent prices or signing configuration and keeps booking gated', async () => {
		state.book = null;
		expect(await submitInquiry(form())).toMatchObject({ status: 503 });
		expect(backend.posts()).toHaveLength(0);
		state.env.BOOKING_ENABLED = 'false';
		await expect(load({ setHeaders: () => {} } as never)).rejects.toMatchObject({ status: 404 });
	});
	it('returns private no-store form data without configuration or credentials', async () => {
		const headers: Record<string, string> = {};
		const data = await load({
			setHeaders: (h: Record<string, string>) => Object.assign(headers, h)
		} as never);
		expect(headers['cache-control']).toContain('no-store');
		const text = JSON.stringify(data);
		for (const secret of [
			TEST_SERVICE_CREDENTIAL,
			state.env.FIONAS_REPLAY_SECRET,
			'FIONAS_PRICES_FILE',
			'priceKey'
		])
			expect(text).not.toContain(secret);
	});
	it('matches server pricing and advisory lines', () => {
		const f = form();
		const projected = projectForm(state.book!);
		const answers = answersFromFormData(projected, f);
		const intent = prepareInquiry(projected, answers);
		if (!intent.ok) throw new Error('Invalid');
		expect(priceInquiry(intent.request, state.book!).lines.every((l) => !('total' in l))).toBe(
			true
		);
	});
	it('prices the base, guests and fifth topping from validated intent; free picks add no line', () => {
		const f = form();
		f.append('offering:topping', 'whipped-cream');
		const projected = projectForm(state.book!);
		const intent = prepareInquiry(projected, answersFromFormData(projected, f));
		if (!intent.ok) throw new Error('Invalid');
		const command = priceInquiry(intent.request, state.book!);
		expect(command.lines.map((l) => [l.description, l.quantity, l.unitPrice])).toEqual([
			['Base service', undefined, '101.00'],
			['Ice cream service', '75', '7.00'],
			['Extra toppings (1)', '75', '0.30']
		]);
	});
	it('rejects an expired authenticated command before any delivery', async () => {
		const f = form();
		const projected = projectForm(state.book!);
		const intent = prepareInquiry(projected, answersFromFormData(projected, f));
		if (!intent.ok) throw new Error('Invalid');
		f.set('outcomeUnknown', 'true');
		f.set(
			'replayRequest',
			sealReplay(
				priceInquiry(intent.request, state.book!),
				KEY,
				state.env.FIONAS_REPLAY_SECRET,
				Date.now() - 24 * 60 * 60 * 1000 - 1
			)
		);
		expect(await submitInquiry(f)).toMatchObject({ ok: false, status: 400 });
		expect(backend.posts()).toHaveLength(0);
	});
	it('replays without current prices and changes the key only for an explicit new submission', async () => {
		backend.script({ status: 500 }, { status: 500 });
		const first = await submitInquiry(form());
		if (first.ok) throw new Error('Expected unknown');
		const book = state.book;
		state.book = null;
		const f = form();
		f.set('outcomeUnknown', 'true');
		f.set('replayRequest', first.failure.replay!.envelope);
		expect((await submitInquiry(f)).ok).toBe(true);
		expect(backend.posts()[2].body).toEqual(backend.posts()[0].body);
		state.book = book;
		f.set('restartToken', first.failure.restartToken!);
		f.set('guestCount', '80');
		expect((await submitInquiry(f)).ok).toBe(true);
		expect(backend.posts()[3].headers['idempotency-key']).not.toBe(KEY);
		expect(backend.posts()[3].body).toHaveProperty('requestedService.guestCount', 80);
	});
});
