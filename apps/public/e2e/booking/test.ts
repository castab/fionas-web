import { test as base, expect } from '@playwright/test';

// Exercise the real component lifecycle without depending on Cloudflare or solving a challenge.
export const test = base.extend({
	page: async ({ page }, use) => {
		await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
			route.fulfill({
				contentType: 'application/javascript',
				body: `
				window.turnstile = {
					render(container, options) {
						const input = document.createElement('input');
						input.type = 'hidden'; input.name = 'cf-turnstile-response';
						input.value = 'e2e-turnstile-token'; container.append(input);
						container.dataset.testWidget = 'true';
						container.addEventListener('test-expire', () => { input.value = ''; options['expired-callback'](); });
						container.addEventListener('test-error', () => { input.value = ''; options['error-callback'](); });
						options.callback(input.value); return 'test-widget';
					},
					remove() { document.querySelector('[data-test-widget]')?.replaceChildren(); }
				};
			`
			})
		);
		await use(page);
	}
});
export { expect };
