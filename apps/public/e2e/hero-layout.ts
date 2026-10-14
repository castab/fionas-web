import { expect, type Page } from '@playwright/test';

/** Guard the breakpoint and intrinsic wrapping that used to put the logo below the CTAs. */
export async function expectResponsiveHero(page: Page) {
	await page.goto('/');
	for (const width of [360, 600, 939, 940, 941, 960, 1000, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		const hero = page.getByRole('main');
		const copy = await hero.locator(':scope > div').first().boundingBox();
		const logo = await hero.locator(':scope > div').last().boundingBox();
		expect(copy).not.toBeNull();
		expect(logo).not.toBeNull();
		if (width < 940) {
			expect(logo!.y + logo!.height).toBeLessThanOrEqual(copy!.y);
			expect(Math.abs(logo!.x + logo!.width / 2 - width / 2)).toBeLessThan(1);
		} else {
			expect(logo!.x).toBeGreaterThanOrEqual(copy!.x + copy!.width);
			expect(Math.abs(logo!.y + logo!.height / 2 - copy!.y - copy!.height / 2)).toBeLessThan(1);
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			width
		);
	}
}
