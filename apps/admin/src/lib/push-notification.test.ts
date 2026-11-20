import { describe, expect, it } from 'vitest';
import {
	NOTIFICATION_BADGE,
	NOTIFICATION_ICON,
	clickTarget,
	notificationFor,
	parsePushPayload,
	safeNotificationPath
} from './push-notification.js';

const testPayload = {
	version: 1,
	notificationId: '1a5bd3fd-6a0a-4d2e-9a7c-3f8f0c2d9e41',
	kind: 'test',
	title: 'Fiona’s test notification',
	body: 'Push notifications are working on this device.',
	url: null
};
const inquiryPayload = {
	...testPayload,
	kind: 'new_inquiry',
	title: 'New catering inquiry',
	body: 'Open Fiona’s admin to review it.',
	url: '/requests/0a6e8577-e811-487f-aa5d-3d30b74b25bd'
};

describe('safeNotificationPath', () => {
	it('keeps paths relative to the admin origin', () => {
		expect(safeNotificationPath('/requests/0a6e8577-e811-487f-aa5d-3d30b74b25bd')).toBe(
			'/requests/0a6e8577-e811-487f-aa5d-3d30b74b25bd'
		);
		expect(safeNotificationPath('/')).toBe('/');
		expect(safeNotificationPath('/requests?filter=new#top')).toBe('/requests?filter=new#top');
		// Dot segments resolve but never leave the origin.
		expect(safeNotificationPath('/a/../requests')).toBe('/requests');
	});

	it('rejects anything that could leave the origin or is not a path', () => {
		const unsafe = [
			'//evil.example/requests',
			'/\\evil.example',
			'/\\/evil.example',
			'https://evil.example/requests',
			'http://admin.fionasicecream.com/requests',
			'javascript:alert(1)',
			'JAVASCRIPT:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'requests/1',
			' /requests',
			'/requests\n',
			'/re quests',
			'/requests\u0000',
			'/a\\b',
			'',
			`/${'a'.repeat(2048)}`,
			null,
			undefined,
			42,
			{ url: '/requests' }
		];
		for (const value of unsafe) expect(safeNotificationPath(value)).toBeNull();
	});
});

describe('parsePushPayload', () => {
	it('reads version 1 test and new-inquiry payloads', () => {
		expect(parsePushPayload(JSON.stringify(testPayload))).toEqual({
			notificationId: testPayload.notificationId,
			kind: 'test',
			title: testPayload.title,
			body: testPayload.body,
			url: null
		});
		expect(parsePushPayload(JSON.stringify(inquiryPayload))?.url).toBe(inquiryPayload.url);
	});

	it('drops an unsafe url but keeps the notification', () => {
		const parsed = parsePushPayload(
			JSON.stringify({ ...inquiryPayload, url: 'https://evil.example' })
		);
		expect(parsed?.title).toBe('New catering inquiry');
		expect(parsed?.url).toBeNull();
	});

	it('rejects anything else', () => {
		const invalid = [
			null,
			'',
			'not json',
			'[]',
			'null',
			JSON.stringify({ ...testPayload, version: 2 }),
			JSON.stringify({ ...testPayload, version: '1' }),
			JSON.stringify({ ...testPayload, notificationId: 7 }),
			JSON.stringify({ ...testPayload, title: '' }),
			JSON.stringify({ ...testPayload, title: '   ' }),
			JSON.stringify({ ...testPayload, body: undefined }),
			JSON.stringify({ ...testPayload, body: 'x'.repeat(5000) })
		];
		for (const text of invalid) expect(parsePushPayload(text)).toBeNull();
	});
});

describe('notificationFor', () => {
	it('tags by notification id so a duplicate replaces the earlier one', () => {
		expect(notificationFor(parsePushPayload(JSON.stringify(inquiryPayload)))).toEqual({
			title: 'New catering inquiry',
			options: {
				body: 'Open Fiona’s admin to review it.',
				tag: inquiryPayload.notificationId,
				data: { url: inquiryPayload.url },
				icon: NOTIFICATION_ICON,
				badge: NOTIFICATION_BADGE
			}
		});
	});

	it('still shows a generic notification for an unreadable push', () => {
		const shown = notificationFor(null);
		expect(shown.title).toBe('Fiona’s Admin');
		expect(shown.options.tag).toBeUndefined();
		expect(shown.options.data).toEqual({ url: null });
	});
});

describe('clickTarget', () => {
	it('opens a safe path, else the dashboard', () => {
		expect(clickTarget({ url: '/requests/1' })).toBe('/requests/1');
		expect(clickTarget({ url: null })).toBe('/');
		expect(clickTarget({ url: '//evil.example' })).toBe('/');
		expect(clickTarget({ url: 'javascript:alert(1)' })).toBe('/');
		expect(clickTarget(null)).toBe('/');
		expect(clickTarget('/requests/1')).toBe('/');
	});
});
