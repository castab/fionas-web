import type {
	StaffRequestResponse,
	FinancialDocumentResponse,
	StageTransitionRequest
} from '../request-contract.js';
import { request, type BackendConfig } from './backend.js';

export function getStaffRequest(config: BackendConfig, inquiryId: string, cookie: string | null) {
	return request<StaffRequestResponse>(config, `/staff/requests/${encodeURIComponent(inquiryId)}`, {
		cookie
	});
}

export function issueQuote(
	config: BackendConfig,
	documentId: string,
	expectedVersion: number,
	cookie: string | null
) {
	const json: StageTransitionRequest = { expectedVersion };
	return request<FinancialDocumentResponse>(
		config,
		`/financial-documents/${encodeURIComponent(documentId)}/quote`,
		{
			method: 'POST',
			json,
			cookie
		}
	);
}
