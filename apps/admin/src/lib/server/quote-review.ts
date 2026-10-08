import { createHash } from 'node:crypto';
import type { DepositTermsRequest } from '../request-contract.js';
import type { QuoteCompositionRequest } from '../quote-contract.js';

/**
 * Identity of the exact command staff previewed. Issuing re-derives the command from the posted
 * form and refuses (re-previewing instead) unless it is byte-for-byte what was reviewed, so an edit
 * made after the preview can never be issued silently, with or without JavaScript.
 */
export function reviewFingerprint(
	expectedDocumentVersion: number,
	composition: QuoteCompositionRequest,
	terms: DepositTermsRequest
): string {
	return createHash('sha256')
		.update(JSON.stringify({ expectedDocumentVersion, composition, terms }))
		.digest('hex');
}
