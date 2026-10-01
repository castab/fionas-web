import type { FieldErrors, InquiryAnswers, InquiryForm } from '@fionas/shared';

/**
 * How a /book submission that did not produce an inquiry is reported back to the page (the form
 * action's `fail()` data). Never carries backend diagnostics or credentials.
 *
 * - `invalid`: answers failed the form's own checks; nothing was sent.
 * - `malformed`: the page itself is out of date (no usable token or revision); reload.
 * - `rejected`: the backend refused the answers (422 and friends); fix them and send again. When the
 *   refusal says the page's options are out of date it comes with a `refreshedForm` to review.
 * - `stale`: the catalog changed while the customer was filling the form in. `refreshedForm` is the
 *   current form, `answers` were fitted to it, and the customer must review before sending again.
 * - `key_reused`: this submission's key already belongs to a different request. Not retried;
 *   `restartToken` lets the customer deliberately send the answers as a new submission.
 * - `unavailable`: nothing was sent (the backend couldn't be reached, or refused our credentials).
 * - `ambiguous`: the request was sent but its outcome is unknown (timeout, lost or garbled response,
 *   gateway error), even after the server's own same-key retry. It may have been recorded. The page
 *   freezes the answers so a retry sends the identical request under the same `submissionToken`;
 *   `restartToken` is only for a customer who deliberately changes their answers instead.
 * - `server_error`: the backend failed unexpectedly (5xx). Safe to send again under the same token.
 */
export type SubmissionOutcome =
	| 'invalid'
	| 'malformed'
	| 'rejected'
	| 'stale'
	| 'key_reused'
	| 'unavailable'
	| 'ambiguous'
	| 'server_error';

export type SubmissionFailure = {
	outcome: SubmissionOutcome;
	answers?: InquiryAnswers;
	errors?: FieldErrors;
	formError?: string;
	/** The `Idempotency-Key` the next submission must carry. Only a reviewed refresh changes it. */
	submissionToken?: string;
	/** The catalog revision the answers belong to, sent back with the next submission. */
	catalogRevision?: number;
	/** `key_reused` / `ambiguous`: a fresh key for a deliberate new submission. */
	restartToken?: string;
	/** The current form after a catalog change, which the page must render from now on. */
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
	serverError:
		'Something went wrong on our side. Please try again in a moment — sending it again won’t create a duplicate.',
	keyReused:
		"We couldn't safely verify this submission. Please restart the request or contact us if you're unsure whether it was received.",
	staleWithoutForm:
		'Our menu changed while you were filling this in. Please reload the page to see the current options.',
	malformed: 'This page is out of date. Please reload it and try again.',
	revisionMissing: 'Our menu just changed. Please reload the page and choose again.'
} as const;
