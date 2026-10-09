import type { FieldErrors, InquiryAnswers, InquiryForm } from '@fionas/shared';

/**
 * How a /book submission that did not produce an inquiry is reported back to the page (the form
 * action's `fail()` data). Never carries NATS diagnostics or credentials.
 *
 * - `invalid`: answers failed the form's own checks; nothing was sent.
 * - `malformed`: the page itself is out of date (no usable token or revision); reload.
 * - `stale`: the private price revision changed while the customer was filling the form in. `refreshedForm` is the
 *   current form, `answers` were fitted to it, and the customer must review before sending again.
 * - `key_reused`: this submission's key already belongs to a different request. Not retried;
 *   `restartToken` lets the customer deliberately send the answers as a new submission.
 * - `unavailable`: nothing was stored (NATS couldn't be reached, no stream captures the event, or
 *   the site may not publish it: an operator problem the visitor is never told about).
 * - `ambiguous`: the request was sent but its outcome is unknown (no acknowledgement in time, a
 *   dropped connection, anything unexpected), even after the server's own same-key retry. It may have been recorded. `replay`
 *   carries the exact request that was delivered; the page freezes the answers and posts `replay`
 *   back, so "Try sending again" resends that same command under the same `submissionToken`.
 *   Without a usable `replay` nothing can safely be resent under that key. `restartToken` is only
 *   for a customer who deliberately changes their answers instead (a new submission).
 */
export type SubmissionOutcome =
	'invalid' | 'malformed' | 'stale' | 'key_reused' | 'unavailable' | 'ambiguous';

/**
 * The immutable command an unresolved submission already published: the signed InquirySubmitted
 * event, exactly as sent under its `Nats-Msg-Id`. Never credentials or tokens; its server-priced
 * amounts are covered by the signature, never trusted from the browser. Distinct from `answers`, which are
 * what the visitor sees and edits: a retry of an unknown outcome resends this, never a request
 * rebuilt from a newer form.
 */
export type InquiryReplay = { envelope: string };

export type SubmissionFailure = {
	outcome: SubmissionOutcome;
	answers?: InquiryAnswers;
	errors?: FieldErrors;
	formError?: string;
	/** The key (`Nats-Msg-Id`) the next submission must carry. Only a reviewed refresh changes it. */
	submissionToken?: string;
	/** The price revision the answers belong to, sent back with the next submission. */
	priceRevision?: string;
	/** `ambiguous`: the command to resend, unchanged, with the same `submissionToken`. */
	replay?: InquiryReplay;
	/** `key_reused` / `ambiguous`: a fresh key for a deliberate new submission. */
	restartToken?: string;
	/** The current form after a price revision change, which the page must render from now on. */
	refreshedForm?: InquiryForm;
	/** With `refreshedForm`: labels of the questions whose answers were dropped or no longer fit. */
	reviewFields?: string[];
	/** With `refreshedForm`: names of chosen options unselected because they're unavailable now. */
	unavailableChoices?: string[];
	/** With `refreshedForm`: how many chosen options the menu no longer lists (never named). */
	removedChoices?: number;
};

export const submissionCopy = {
	unavailable:
		"We couldn't reach our request system, so your request hasn't been sent. Please try again in a moment.",
	ambiguous:
		"We couldn't confirm your request was received. Please try sending it again — if it did reach us, we won't record it twice.",
	keyReused:
		"We couldn't safely verify this submission. Please restart the request or contact us if you're unsure whether it was received.",
	staleWithoutForm:
		'Our menu changed while you were filling this in. Please reload the page to see the current options.',
	malformed: 'This page is out of date. Please reload it and try again.',
	replayUnusable:
		"We couldn't safely resend your earlier request from this page, so nothing was sent. Email us to check whether it reached us, or change your answers to send a new request.",
	revisionMissing: 'Our menu just changed. Please reload the page and choose again.'
} as const;
