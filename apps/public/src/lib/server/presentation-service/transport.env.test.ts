import { expect, test, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: {
		PRESENTATION_SERVICE_BASE_URL: undefined,
		PRESENTATION_SERVICE_ACCOUNT_ID: 'kit-account',
		PRESENTATION_SERVICE_GALLERY_NAME: 'kit-gallery',
		PRESENTATION_SERVICE_TRACKING_TOKEN: 'kit-token-at-least-16-characters'
	}
}));

import {
	presentationServiceAccountId,
	presentationServiceGalleryName,
	presentationServiceTrackingToken
} from './transport.server.js';

test('reads Knurl settings from SvelteKit server env', () => {
	expect(presentationServiceAccountId()).toBe('kit-account');
	expect(presentationServiceGalleryName()).toBe('kit-gallery');
	expect(presentationServiceTrackingToken()).toBe('kit-token-at-least-16-characters');
});
