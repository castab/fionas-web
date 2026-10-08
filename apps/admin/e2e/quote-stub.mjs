// Fixture-only stand-in for POST /staff/requests/{id}/quote-preview and composed issuance. It mirrors
// the API's contract (modes, provenance, overrides, adjustments, violations, review tokens) with a
// tiny pricing policy from catalog-fixture.mjs. The application never computes any of this.
import { createHash, randomUUID } from 'node:crypto';
import { offeringCatalog, durations, stubPricing } from './catalog-fixture.mjs';
import {
	fixtureDecimal,
	fixtureMinor,
	resolveDepositAmount,
	proposalPair
} from './request-fixture.mjs';

/** @param {number} status @param {string} code @param {string[]} [violations] */
const refusal = (status, code, violations = []) => ({
	status,
	body: {
		code,
		message: 'PRIVATE quote composition diagnostic',
		...(violations.length && { violations: violations.map((violation) => ({ code: violation })) })
	}
});

/** @param {unknown} value */
const isMoney = (value) => typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value);

/** @param {any} config @param {ReturnType<typeof offeringCatalog>} catalog */
function priceConfiguration(config, catalog) {
	const guests = BigInt(config.guestCount);
	const label = durations.find((d) => d.value === config.durationMinutes)?.label;
	const base = stubPricing.base[config.durationMinutes];
	if (!label || !base) return null;
	/** @param {any} source @param {string} description @param {string} unitPrice @param {{ quantity?: bigint, subDescription?: string }} [extra] */
	const line = (source, description, unitPrice, extra = {}) => {
		const total =
			extra.quantity === undefined
				? fixtureMinor(unitPrice)
				: fixtureMinor(unitPrice) * extra.quantity;
		return {
			origin: { type: 'GENERATED', source },
			description,
			...(extra.subDescription && { subDescription: extra.subDescription }),
			...(extra.quantity !== undefined && { quantity: String(extra.quantity) }),
			unitPrice,
			subtotal: fixtureDecimal(total),
			taxAmount: '0.00',
			total: fixtureDecimal(total),
			currency: 'USD'
		};
	};
	const lines = [
		line({ type: 'BASE_SERVICE' }, 'Base service', base, {
			subDescription: `${label} · setup, staff & local travel`
		}),
		line({ type: 'ICE_CREAM_SERVICE' }, 'Ice cream service', stubPricing.perGuest, {
			quantity: guests,
			subDescription: `${config.guestCount} guests`
		})
	];
	for (const selection of config.selections) {
		const category = catalog.categories.find((c) => c.key === selection.category);
		for (const key of selection.offerings) {
			const offering = category?.offerings.find((o) => o.key === key);
			if (offering?.price)
				lines.push(
					line(
						{ type: 'SELECTED_OFFERING', category: selection.category, offering: key },
						offering.displayName,
						offering.price.amount,
						{ quantity: guests }
					)
				);
		}
	}
	const toppings =
		config.selections.find((s) => s.category === stubPricing.toppingCategory)?.offerings.length ??
		0;
	if (toppings > stubPricing.includedToppings) {
		const extra = BigInt(toppings - stubPricing.includedToppings);
		lines.push(
			line(
				{ type: 'EXTRA_TOPPINGS' },
				`Extra toppings (${extra})`,
				fixtureDecimal(fixtureMinor(stubPricing.extraTopping) * extra),
				{ quantity: guests }
			)
		);
	}
	return lines;
}

/** @param {any} selections @param {ReturnType<typeof offeringCatalog>} catalog */
function selectionViolations(selections, catalog) {
	if (!Array.isArray(selections)) return ['MALFORMED'];
	for (const selection of selections) {
		const category = catalog.categories.find((c) => c.key === selection?.category);
		if (!category || !Array.isArray(selection.offerings)) return ['UNKNOWN_OFFERING'];
		for (const key of selection.offerings) {
			const offering = category.offerings.find((o) => o.key === key);
			if (!offering || offering.selectionState !== 'ENABLED') return ['UNKNOWN_OFFERING'];
			if (offering.availability !== 'AVAILABLE') return ['OFFERING_UNAVAILABLE'];
		}
		if (
			category.maximumSelections != null &&
			selection.offerings.length > category.maximumSelections
		)
			return ['TOO_MANY_SELECTIONS'];
		if (selection.offerings.length < category.minimumSelections) return ['TOO_FEW_SELECTIONS'];
	}
	return [];
}

/** @param {any[]} lines */
const chargeFacts = (lines) =>
	JSON.stringify(
		lines.map((l) => [l.description, l.subDescription, l.quantity, l.unitPrice, l.total])
	);

/**
 * @param {any} session
 * @param {import('../src/lib/request-contract.js').CurrentStaffRequest} request
 * @param {any} body
 */
export function previewQuote(session, request, body) {
	if (
		!body ||
		!Number.isInteger(body.expectedDocumentVersion) ||
		!body.composition?.pricing ||
		!body.terms
	)
		return refusal(400, 'malformed_request');
	if (
		body.expectedDocumentVersion !== request.financial.version ||
		request.financial.stage !== 'ESTIMATE' ||
		request.inquiry.lifecycle.stage !== 'REQUESTED' ||
		request.proposal != null
	)
		return refusal(409, 'conflict');
	const catalog = offeringCatalog(session.catalogRevision);
	const { pricing, overrides = [], adjustments = [] } = body.composition;
	const effective = request.inquiry.pricingInputs;
	const estimateLines = request.financial.lines.map(({ id, ...line }) => ({
		lineItemId: id,
		origin: { type: 'ESTIMATE_LINE' },
		...line
	}));
	let lines;
	let config = effective;
	if (pricing.mode === 'KEEP_ESTIMATE') {
		if (Object.keys(pricing).length !== 1) return refusal(400, 'malformed_request');
		lines = [...estimateLines];
	} else if (
		pricing.mode === 'REVISE_SERVICE_SELECTIONS' ||
		pricing.mode === 'REPRICE_CONFIGURATION'
	) {
		if (pricing.catalogRevision !== session.catalogRevision)
			return refusal(409, 'CATALOG_REVISION_STALE');
		const violations = selectionViolations(pricing.selections, catalog);
		if (violations.length) return refusal(422, 'validation_failed', violations);
		if (pricing.mode === 'REVISE_SERVICE_SELECTIONS') {
			if (Object.keys(pricing).sort().join() !== 'catalogRevision,mode,selections')
				return refusal(400, 'malformed_request');
			config = { ...effective, selections: pricing.selections };
			const before = priceConfiguration(effective, catalog);
			const after = priceConfiguration(config, catalog);
			if (
				JSON.stringify(before?.map((l) => [l.origin, l.total])) !==
				JSON.stringify(after?.map((l) => [l.origin, l.total]))
			)
				return refusal(422, 'validation_failed', ['SERVICE_SELECTIONS_CHANGE_PRICING']);
			lines = [...estimateLines];
		} else {
			if (!Number.isInteger(pricing.guestCount) || pricing.guestCount < 1)
				return refusal(422, 'validation_failed', ['INVALID_GUEST_COUNT']);
			config = pricing;
			lines = priceConfiguration(config, catalog);
			if (!lines) return refusal(422, 'validation_failed', ['UNSUPPORTED_DURATION']);
		}
	} else return refusal(400, 'malformed_request');

	const repricing = pricing.mode === 'REPRICE_CONFIGURATION';
	const seen = new Set();
	for (const override of overrides) {
		const target = override?.target;
		const key = JSON.stringify(target);
		if (seen.has(key)) return refusal(422, 'validation_failed', ['DUPLICATE_OVERRIDE_TARGET']);
		seen.add(key);
		if (!isMoney(override.finalAmount) || !override.reason || override.currency !== 'USD')
			return refusal(422, 'validation_failed', ['INVALID_OVERRIDE']);
		if ((target?.type === 'EXISTING_LINE') === repricing)
			return refusal(422, 'validation_failed', ['OVERRIDE_TARGET_NOT_ALLOWED']);
		const index = lines.findIndex((line) =>
			target.type === 'EXISTING_LINE'
				? line.lineItemId === target.lineItemId
				: JSON.stringify(line.origin.source) === JSON.stringify(target)
		);
		if (index < 0) return refusal(422, 'validation_failed', ['OVERRIDE_TARGET_NOT_FOUND']);
		const line = lines[index];
		if (fixtureMinor(override.finalAmount) === fixtureMinor(line.total))
			return refusal(422, 'validation_failed', ['OVERRIDE_UNCHANGED']);
		const amount = fixtureDecimal(fixtureMinor(override.finalAmount));
		const { quantity, ...rest } = line;
		lines[index] = {
			...rest,
			...(quantity !== undefined && { subDescription: undefined }),
			unitPrice: amount,
			subtotal: amount,
			total: amount,
			override: {
				reason: override.reason,
				...(quantity !== undefined && { originalQuantity: quantity }),
				originalUnitPrice: line.unitPrice,
				originalTotal: line.total
			}
		};
		if (lines[index].subDescription === undefined) delete lines[index].subDescription;
	}
	const keys = new Set();
	for (const adjustment of adjustments) {
		if (keys.has(adjustment?.clientKey))
			return refusal(422, 'validation_failed', ['DUPLICATE_ADJUSTMENT_KEY']);
		keys.add(adjustment.clientKey);
		if (
			!['CHARGE', 'DISCOUNT', 'CREDIT'].includes(adjustment.kind) ||
			!isMoney(adjustment.amount) ||
			fixtureMinor(adjustment.amount) <= 0n ||
			!adjustment.description ||
			!adjustment.reason
		)
			return refusal(422, 'validation_failed', ['INVALID_ADJUSTMENT']);
		const magnitude = fixtureMinor(adjustment.amount);
		const signed = fixtureDecimal(adjustment.kind === 'CHARGE' ? magnitude : -magnitude);
		lines.push({
			origin: {
				type: 'ADJUSTMENT',
				kind: adjustment.kind,
				reason: adjustment.reason,
				clientKey: adjustment.clientKey
			},
			description: adjustment.description,
			...(adjustment.subDescription && { subDescription: adjustment.subDescription }),
			unitPrice: signed,
			subtotal: signed,
			taxAmount: '0.00',
			total: signed,
			currency: 'USD'
		});
	}
	const total = lines.reduce(
		(sum, line) =>
			sum + fixtureMinor(line.total.replace('-', '')) * (line.total.startsWith('-') ? -1n : 1n),
		0n
	);
	if (total < 0n) return refusal(422, 'validation_failed', ['NEGATIVE_DOCUMENT_TOTAL']);
	if (total === 0n) return refusal(422, 'validation_failed', ['QUOTE_TOTAL_NOT_POSITIVE']);
	let deposit;
	try {
		deposit = resolveDepositAmount(fixtureDecimal(total), body.terms, 'USD');
	} catch {
		return refusal(422, 'validation_failed', ['INVALID_DEPOSIT_TERMS']);
	}
	if (fixtureMinor(deposit) > total)
		return refusal(422, 'validation_failed', ['QUOTE_TOTAL_NOT_POSITIVE']);
	const financialChange = chargeFacts(lines) !== chargeFacts(estimateLines);
	const names = (selections) =>
		selections
			.filter((s) => s.offerings.length)
			.map((s) => {
				const category = catalog.categories.find((c) => c.key === s.category);
				return {
					category: s.category,
					displayName: category?.displayName ?? s.category,
					offerings: s.offerings.map((key) => ({
						offering: key,
						displayName: category?.offerings.find((o) => o.key === key)?.displayName ?? key
					}))
				};
			});
	const reviewToken = createHash('sha256')
		.update(
			JSON.stringify({
				version: body.expectedDocumentVersion,
				composition: body.composition,
				terms: body.terms,
				revision: session.catalogRevision,
				epoch: session.quoteEpoch
			})
		)
		.digest('hex');
	return {
		status: 200,
		body: {
			inquiryId: request.inquiry.id,
			documentId: request.financial.id,
			reviewedDocumentVersion: request.financial.version,
			estimateTotal: request.financial.total,
			pricingBasis: pricing.mode,
			catalogRevision: session.catalogRevision,
			financialChange,
			quoteVersion: request.financial.version + (financialChange ? 2 : 1),
			service: {
				guestCount: config.guestCount,
				guestCountIsMinimum: config.guestCountIsMinimum ?? false,
				durationMinutes: config.durationMinutes,
				selections: names(config.selections)
			},
			lines,
			subtotal: fixtureDecimal(total),
			taxAmount: '0.00',
			total: fixtureDecimal(total),
			currency: 'USD',
			deposit: {
				terms: structuredClone(body.terms),
				requiredAmount: { amount: deposit, currency: 'USD' }
			},
			reviewToken
		}
	};
}

/**
 * Apply an issued composition the way the API would: Quote lines get ids, the plan records them.
 * @param {import('../src/lib/request-contract.js').CurrentStaffRequest} request
 * @param {any} preview
 * @param {any} terms
 * @param {string} principalId
 */
export function issueComposedQuote(request, preview, terms, principalId) {
	const lines = preview.lines.map((/** @type {any} */ line) => ({
		...line,
		lineItemId: line.lineItemId ?? randomUUID()
	}));
	request.financial.previousVersion = request.financial.version;
	request.financial.version = preview.quoteVersion;
	request.financial.stage = 'QUOTE';
	request.financial.createdAt = '2026-07-16T19:01:00Z';
	request.financial.lines = lines.map((/** @type {any} */ line) => {
		const { lineItemId, ...rest } = line;
		delete rest.origin;
		delete rest.override;
		return { id: lineItemId, ...rest };
	});
	request.financial.subtotal = preview.subtotal;
	request.financial.total = preview.total;
	if (request.financial.reconciliation) request.financial.reconciliation.balance = preview.total;
	request.inquiry.lifecycle.stage = 'QUOTED';
	Object.assign(
		request,
		proposalPair(
			request.inquiry.id,
			request.financial.id,
			preview.quoteVersion,
			preview.total,
			terms,
			'USD'
		)
	);
	request.servicePlan = {
		documentId: request.financial.id,
		documentVersion: preview.quoteVersion,
		reviewedDocumentVersion: preview.reviewedDocumentVersion,
		pricingBasis: preview.pricingBasis,
		catalogRevision: preview.catalogRevision,
		approvedAt: '2026-07-16T19:01:00Z',
		principalKind: 'USER',
		principalId,
		service: preview.service,
		lines: lines.map((/** @type {any} */ line) => {
			const origin = { ...line.origin };
			delete origin.clientKey;
			return {
				lineItemId: line.lineItemId,
				origin,
				...(line.override && { overrideReason: line.override.reason })
			};
		})
	};
}
