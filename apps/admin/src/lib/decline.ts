/** The backend's `DeclineReason.MAX_LENGTH`, counted after trimming (UTF-16 code units, as both sides count). */
export const DECLINE_REASON_MAX = 500;

export type DeclineFormValues = {
	/** The canonical Estimate version the staff member reviewed, exactly as the page carried it. */
	expectedDocumentVersion: string;
	/** The reason as typed, kept for redisplay; `declineReason` derives what is sent. */
	reason: string;
};
export type DeclineReasonProblem = 'blank' | 'too-long';

/**
 * Exactly one `expectedDocumentVersion` and one `reason`, nothing else. Identity, actor, time and
 * stage never come from the browser: the route names the inquiry and authentication the actor.
 */
export function readDeclineForm(form: FormData): DeclineFormValues | null {
	const fields = ['expectedDocumentVersion', 'reason'];
	if (
		[...form.keys()].some((key) => !fields.includes(key)) ||
		fields.some((key) => form.getAll(key).length !== 1 || typeof form.get(key) !== 'string')
	)
		return null;
	const expectedDocumentVersion = form.get('expectedDocumentVersion') as string;
	const reason = form.get('reason') as string;
	if (
		!/^[1-9]\d*$/.test(expectedDocumentVersion) ||
		Number(expectedDocumentVersion) > 2_147_483_647 ||
		reason.length > 10_000
	)
		return null;
	return { expectedDocumentVersion, reason };
}

/**
 * The reason as sent: form submission turns each line break into CRLF, so line breaks are
 * normalized back to one newline (the note reads the same), then surrounding whitespace is trimmed.
 */
export function declineReason(raw: string): string {
	return raw.replace(/\r\n?/g, '\n').trim();
}

export function declineReasonProblem(raw: string): DeclineReasonProblem | null {
	const reason = declineReason(raw);
	if (!reason) return 'blank';
	return reason.length > DECLINE_REASON_MAX ? 'too-long' : null;
}

export function declineReasonMessage(problem: DeclineReasonProblem): string {
	return problem === 'blank'
		? 'Enter a reason for declining.'
		: `Keep the reason to ${DECLINE_REASON_MAX} characters or fewer.`;
}

/** Staff-facing copy only; backend messages and identifiers are never shown. */
export function declineErrorMessage(status: number, mutationAttempted = false): string {
	if (status === 422)
		return `Check the reason: it must not be blank and must be ${DECLINE_REASON_MAX} characters or fewer.`;
	if (status === 403) return 'This account cannot decline requests.';
	if (status === 404)
		return 'This request is no longer available. Reload to review the latest state.';
	if (status === 409)
		return 'This request changed or has already been handled since you opened it. Reload to review its latest status.';
	if (status === 400)
		return 'This decline couldn’t be read. Reload to review the request before trying again.';
	if (status >= 500 && mutationAttempted)
		return 'We couldn’t confirm whether this request was declined. Reload to review its latest status before taking another action.';
	return 'We couldn’t review the latest request state. Nothing was declined. Reload before trying again.';
}
