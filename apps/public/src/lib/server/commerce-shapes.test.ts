import { it, expect } from 'vitest';
import { isCreateInquiryRequest } from './commerce-shapes.js';
it('rejects arbitrary browser JSON as a priced request', () => {
	expect(isCreateInquiryRequest({})).toBe(false);
	expect(isCreateInquiryRequest(null)).toBe(false);
});
