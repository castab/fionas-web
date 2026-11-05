/**
 * Customer-facing wording for payment notices. Specific, plain language; never a raw backend code
 * or message. Confirmations are worded only from the authoritative summary passed in.
 */
import type { CustomerPaymentSummary } from './contract.js';
import type { NoticeKind } from './controller.js';
import { decimalToCents, formatCents } from './money.js';

export type NoticeTone = 'success' | 'info' | 'warning' | 'error';
export type NoticeCopy = { tone: NoticeTone; title: string; body: string; contact?: boolean };

export const STAFF_REVIEW_MESSAGE =
	"We received a payment that needs staff review. Please contact Fiona's before paying again.";

/**
 * When a payment from this tab may exist but its outcome can't be read. Never "you weren't
 * charged": an outage or a cancel redirect says nothing about money.
 */
export const STATUS_UNKNOWN_MESSAGE =
	"We can't confirm your payment status right now. Please don't make another payment until we've checked it. Contact Fiona's if you need assistance.";

function balanceSentence(summary: CustomerPaymentSummary | null): string {
	const balance = summary ? decimalToCents(summary.balance) : null;
	if (balance === null) return 'Your updated balance is shown below.';
	return balance <= 0n
		? 'Your booking is paid in full.'
		: `Your remaining balance is ${formatCents(balance)}.`;
}

export function noticeCopy(
	kind: NoticeKind,
	summary: CustomerPaymentSummary | null,
	paymentUncertain = false
): NoticeCopy {
	switch (kind) {
		case 'deposit-confirmed':
			return {
				tone: 'success',
				title: 'Deposit received. Your booking is confirmed.',
				body: `Thank you! Your date is on our calendar. ${balanceSentence(summary)}`
			};
		case 'payment-received':
			return { tone: 'success', title: 'Payment received.', body: balanceSentence(summary) };
		case 'confirming':
			return {
				tone: 'info',
				title: 'Confirming your payment',
				body: "We're waiting for our payment processor to confirm it. This page updates on its own, so there's no need to pay again."
			};
		case 'checkout-cancelled-open':
			return {
				tone: 'info',
				title: 'Checkout was cancelled',
				body: 'That checkout may stay open for a little while. You can go back to it below, or wait for it to expire before starting a new payment.'
			};
		case 'embedded-closed':
			// The form was closed or the page reloaded: the Session may still be open, and the
			// customer may even have just submitted it. Never imply either way that money moved.
			return {
				tone: 'info',
				title: 'Your payment is still open',
				body: "If you already submitted your card details, we'll confirm the payment here shortly. Otherwise, continue below to return to the same payment; it never starts a second one."
			};
		case 'embedded-invalidated':
			// The form was removed because the booking's terms changed under it. Unmounting proves
			// nothing about the Session or money: never say cancelled, expired or not charged.
			return {
				tone: 'warning',
				title: "Your booking's payment details have changed",
				body: "The payment form you opened may no longer match your booking's current balance or terms. We've closed the form while we check the earlier payment. Please review the updated details before trying to pay again.",
				contact: true
			};
		case 'checkout-not-completed':
			return {
				tone: 'info',
				title: "Your last checkout wasn't completed",
				body: "It doesn't show as paid on your booking. Review your balance below whenever you're ready, and contact us if anything looks off.",
				contact: true
			};
		case 'checkout-expired':
			return {
				tone: 'info',
				title: 'That checkout has expired',
				body: 'Review the amount below and start a new payment when you are ready.'
			};
		case 'refresh-failed':
			return paymentUncertain
				? {
						tone: 'warning',
						title: "We couldn't refresh your booking",
						body: `The details below may be out of date. ${STATUS_UNKNOWN_MESSAGE}`,
						contact: true
					}
				: {
						tone: 'warning',
						title: "We couldn't refresh your booking",
						body: 'The details below may be out of date, so paying is paused until they load. Check your connection, then try again.'
					};
		case 'ambiguous':
			return {
				tone: 'warning',
				title: "We couldn't confirm your payment started",
				body: 'The connection dropped before we heard back, so the payment may or may not have started. Trying again safely continues that same payment instead of starting a new one.',
				contact: true
			};
		case 'terms-changed':
			return {
				tone: 'warning',
				title: 'Your booking was updated',
				body: "Fiona's updated your booking since you opened this page. Please review the current amount below before paying."
			};
		case 'key-reused':
			return {
				tone: 'error',
				title: "We couldn't start this payment",
				body: 'Something went wrong with this payment request. Start over to review your current balance.',
				contact: true
			};
		case 'reconciliation-pending':
		case 'reconciliation-required':
			return {
				tone: 'warning',
				title: 'A payment needs staff review',
				body: STAFF_REVIEW_MESSAGE,
				contact: true
			};
		case 'checkout-open':
			return {
				tone: 'info',
				title: 'An earlier checkout is still open',
				body: 'If you still have it open, you can finish there. Otherwise it expires on its own within about an hour; check back after that.'
			};
		case 'processing':
			return {
				tone: 'info',
				title: 'A payment is being confirmed',
				body: "An earlier payment is still processing. Please don't start another one; this page updates when it's confirmed."
			};
		case 'state-changed':
			return {
				tone: 'info',
				title: 'We found an earlier payment',
				body: 'An earlier payment was recorded. Please review your updated balance before paying again.'
			};
		case 'recovery-conflict':
			return {
				tone: 'info',
				title: 'Your payment status just changed',
				body: 'Please review the details below, then try again if a payment is still due.'
			};
		case 'invalid-amount':
			return {
				tone: 'error',
				title: "That amount can't be paid online",
				body: 'Please check the amount and try again, or contact us and we will help.',
				contact: true
			};
		case 'malformed':
		case 'refused':
			return {
				tone: 'error',
				title: "We couldn't start this payment",
				body: 'Please review the details below and try again. If it keeps happening, contact us.',
				contact: true
			};
	}
}
