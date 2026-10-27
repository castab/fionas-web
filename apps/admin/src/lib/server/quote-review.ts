import { createHash } from 'node:crypto';
import type { DepositTermsRequest } from '../request-contract.js';
import type { QuoteCommand, RevisionCommand } from '../quote-contract.js';
import type { FinancialEditorMode } from '../financial-editor.js';

/**
 * Everything staff reviewed, as one identity. The editor mode, every revision they reviewed against
 * (financial version, deposit revision and publication, service approval), the plan action and the
 * complete proposed content all take part, so a change to any of them can never publish silently.
 */
export type ReviewIdentity = {
	mode: FinancialEditorMode;
	expectedDocumentVersion: number;
	expectedDepositRevision?: number;
	expectedProposalId?: string;
	expectedPlanRevision?: number | null;
	command: QuoteCommand | RevisionCommand;
	terms?: DepositTermsRequest;
};

/**
 * Identity of the exact command staff previewed. Publishing re-derives the command from the posted
 * form and refuses (re-previewing instead) unless it is byte-for-byte what was reviewed, so an edit
 * made after the preview can never be published silently, with or without JavaScript. Terms are
 * canonical: the same terms hash alike whether they came from the form or from Commerce's JSON.
 *
 * This is a local guard only. The backend's `reviewToken` remains the authority.
 */
export function reviewFingerprint(identity: ReviewIdentity): string {
	const { terms } = identity;
	const canonicalTerms = !terms
		? null
		: terms.type === 'PERCENTAGE'
			? { type: terms.type, percentage: terms.percentage }
			: { type: terms.type, amount: terms.amount, currency: terms.currency };
	return createHash('sha256')
		.update(
			JSON.stringify({
				mode: identity.mode,
				expectedDocumentVersion: identity.expectedDocumentVersion,
				expectedDepositRevision: identity.expectedDepositRevision ?? null,
				expectedProposalId: identity.expectedProposalId ?? null,
				expectedPlanRevision: identity.expectedPlanRevision ?? null,
				command: identity.command,
				terms: canonicalTerms
			})
		)
		.digest('hex');
}
