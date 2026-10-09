import { createHash } from 'node:crypto';
import type { DepositTermsRequest } from '../request-contract.js';
import type { QuoteCommand } from '../quote-contract.js';

/**
 * Identity of the exact command staff previewed. Issuing re-derives the command from the posted
 * form and refuses (re-previewing instead) unless it is byte-for-byte what was reviewed, so an edit
 * made after the preview can never be issued silently, with or without JavaScript. Terms are
 * canonical: the same terms hash alike whether they came from the form or from Commerce's JSON.
 */
export function reviewFingerprint(
	expectedDocumentVersion: number,
	command: QuoteCommand,
	terms: DepositTermsRequest
): string {
	const canonicalTerms =
		terms.type === 'PERCENTAGE'
			? { type: terms.type, percentage: terms.percentage }
			: { type: terms.type, amount: terms.amount, currency: terms.currency };
	return createHash('sha256')
		.update(JSON.stringify({ expectedDocumentVersion, command, terms: canonicalTerms }))
		.digest('hex');
}
