import type { FieldErrors, InquiryAnswers, InquiryForm } from '@fionas/shared';

/**
 * How a /book submission that did not produce an inquiry is reported back to the page (the form
 * action's `fail()` data). Never carries backend diagnostics or credentials.
 *
 * - `invalid`: answers failed the form's own checks; nothing was sent.
 * - `rejected`: the backend refused the answers (422 and friends); fix them and send again.
 * - `stale`: the catalog changed while the customer was filling the form in. `refreshedForm` is the
 *   current form, `answers` were fitted to it, and the customer must review before sending again.
 * - `key_reused`: this submission's key already belongs to a different request. Not retried;
 *   `restartToken` lets the customer deliberately send the answers as a new submission.
 * - `unavailable`: the outcome is unknown or the backend is down. Retrying is safe: the same
 *   `submissionToken` comes back, so a request that did go through is not recorded twice.
 * - `malformed`: the page itself is out of date (no usable token or revision); reload.
 */
export type SubmissionFailure = {
	outcome: 'invalid' | 'rejected' | 'stale' | 'key_reused' | 'unavailable' | 'malformed';
	answers?: InquiryAnswers;
	errors?: FieldErrors;
	formError?: string;
	/** The `Idempotency-Key` the next submission must carry. Only a reviewed refresh changes it. */
	submissionToken?: string;
	/** The catalog revision the answers belong to, sent back with the next submission. */
	catalogRevision?: number;
	/** `key_reused` only: a fresh key for a deliberate "send as a new request". */
	restartToken?: string;
	/** `stale` only: the current form, which the page must render from now on. */
	refreshedForm?: InquiryForm;
	/** `stale` only: labels of the questions whose answers were dropped or no longer fit. */
	reviewFields?: string[];
};

export const submissionCopy = {
	unavailable:
		"We couldn't confirm your request was sent. Please try again in a moment — sending it again won't create a duplicate.",
	keyReused:
		"This request doesn't match the one this page already sent us, so we haven't recorded it. If you meant to change your details, send it as a new request.",
	staleWithoutForm:
		'Our menu changed while you were filling this in. Please reload the page to see the current options.',
	malformed: 'This page is out of date. Please reload it and try again.',
	revisionMissing: 'Our menu just changed. Please reload the page and choose again.'
} as const;
