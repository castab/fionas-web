/** Customer payment summaries shaped exactly like commerce's documented examples. */
export const publicId = 'b8251ea0-c07c-4aad-bceb-644ed075c0a1';
export const token = 'A'.repeat(21) + '_-' + 'z'.repeat(20);
export const otherToken = 'B'.repeat(43);
export const restartToken = `99ba495c-4747-4dc4-87ed-69357de3cba9.${token}.${otherToken}`;
export const restartEligible = {
	canPay: false,
	paymentInProgress: true,
	unavailableReason: 'PAYMENT_IN_PROGRESS',
	checkoutRecoveryAvailable: true,
	checkoutRestartToken: restartToken
};

export function quotedSummary(overrides: Record<string, unknown> = {}) {
	return {
		inquiryId: 'f693da9b-bca4-4107-99dc-c1e68b922af6',
		eventDate: '2027-05-01',
		lifecycle: 'QUOTED',
		document: {
			id: 'f79d5d1c-cc9e-4e08-a231-a1ea1696330e',
			version: 3,
			stage: 'QUOTE',
			businessRevision: 4,
			currency: 'USD',
			totalAmount: '1200.00'
		},
		mode: 'DEPOSIT',
		requiredAmount: '240.00',
		paidAmount: '0.00',
		balance: '1200.00',
		canPay: true,
		paymentInProgress: false,
		reconciliationPending: false,
		checkoutRecoveryAvailable: false,
		history: [],
		...overrides
	};
}

export function bookedSummary(overrides: Record<string, unknown> = {}) {
	return quotedSummary({
		lifecycle: 'BOOKED',
		document: {
			id: 'f79d5d1c-cc9e-4e08-a231-a1ea1696330e',
			version: 6,
			stage: 'INVOICE',
			businessRevision: 8,
			acceptedQuoteRevision: 4,
			currency: 'USD',
			totalAmount: '1200.00'
		},
		mode: 'INVOICE',
		requiredAmount: '960.00',
		paidAmount: '240.00',
		balance: '960.00',
		history: [{ amount: '240.00', refundedAmount: '0.00', receivedAt: '2027-03-01T18:00:00Z' }],
		...overrides
	});
}

/** An open hosted attempt (fionas-commerce PR #38 shape). */
export const openCheckout = {
	attemptId: '8cf42464-739b-43ca-b684-d0f802245c55',
	uiMode: 'HOSTED',
	url: 'https://checkout.stripe.com/c/pay/cs_test_123',
	state: 'OPEN',
	outcome: 'PENDING'
};

/** An open hosted attempt from a commerce release without `uiMode` (deploy overlap only). */
export const legacyOpenCheckout = {
	attemptId: '8cf42464-739b-43ca-b684-d0f802245c55',
	url: 'https://checkout.stripe.com/c/pay/cs_test_123',
	state: 'OPEN',
	outcome: 'PENDING'
};

/** A recognizable fake client secret: tests assert it never leaks anywhere persistent. */
export const embeddedSecret = 'cs_test_a1EmbeddedFixture_secret_DoNotPersist42';

/** An open embedded attempt (fionas-commerce PR #38 shape). */
export const embeddedCheckout = {
	attemptId: '5d0b8f8e-29c4-4d6e-9f63-0b9b4f1d2a77',
	uiMode: 'EMBEDDED',
	clientSecret: embeddedSecret,
	state: 'OPEN',
	outcome: 'PENDING'
};
