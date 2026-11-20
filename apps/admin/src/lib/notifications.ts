/**
 * Staff Web Push: the shapes the admin reads from commerce, the same-origin routes the page and the
 * service worker call, and the copy shown for each outcome. Client-safe (no server imports); the
 * server projects every commerce response through these readers before it reaches a browser.
 * See docs/admin-push-notifications.md.
 */

/** Same-origin JSON endpoints (never commerce). The service worker posts to `subscriptions`. */
export const PUSH_ROUTES = {
	config: '/settings/notifications/config',
	subscriptions: '/settings/notifications/subscriptions',
	test: '/settings/notifications/test'
} as const;

export const deviceRoute = (subscriptionId: string) =>
	`${PUSH_ROUTES.subscriptions}/${encodeURIComponent(subscriptionId)}`;
export const testStatusRoute = (notificationId: string) =>
	`${PUSH_ROUTES.test}/${encodeURIComponent(notificationId)}`;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Commerce's Idempotency-Key shape; also enforced by `request()`'s capability check. */
export const TEST_KEY = /^[A-Za-z0-9_-]{1,128}$/;
/** Commerce accepts 64; the admin keeps labels a little shorter. */
export const LABEL_MAX = 60;

export type PushConfig = { enabled: false } | { enabled: true; vapidPublicKey: string };

export type PushService = 'FCM' | 'MOZILLA' | 'WINDOWS' | 'APPLE' | 'OTHER';
export type PushDevice = {
	subscriptionId: string;
	label: string | null;
	service: string;
	state: 'ACTIVE' | 'EXPIRED';
	enrolledAt: string;
	refreshedAt: string;
	expirationTime: string | null;
};

export const TEST_STATUSES = [
	'queued',
	'retrying',
	'push_accepted',
	'push_failed',
	'skipped'
] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];
export type TestQueued = { notificationId: string; status: TestStatus };
export type TestNotification = {
	notificationId: string;
	subscriptionId: string;
	status: TestStatus;
	attempts: number;
	queuedAt: string;
	lastAttemptAt: string | null;
	completedAt: string | null;
	failureReason: string | null;
	providerCode: number | null;
};

/** The error envelope our endpoints answer with: our code and our copy, never commerce's text. */
export type NotificationFailure = {
	status: number;
	code: NotificationFailureCode;
	message: string;
};
export type NotificationFailureCode =
	| 'unauthenticated'
	| 'forbidden'
	| 'not_found'
	| 'push_endpoint_in_use'
	| 'IDEMPOTENCY_KEY_REUSED'
	| 'validation_failed'
	| 'push_notifications_disabled'
	| 'unavailable';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 200): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalText = (value: unknown, max = 200): string | null | undefined =>
	value === undefined || value === null ? null : isText(value, max) ? value : undefined;

export function readPushConfig(data: unknown): PushConfig | null {
	if (!isRecord(data) || typeof data.enabled !== 'boolean') return null;
	if (!data.enabled) return { enabled: false };
	return isText(data.vapidPublicKey, 256) && /^[A-Za-z0-9_-]+={0,2}$/.test(data.vapidPublicKey)
		? { enabled: true, vapidPublicKey: data.vapidPublicKey }
		: null;
}

export function readPushDevice(data: unknown): PushDevice | null {
	if (!isRecord(data)) return null;
	const { subscriptionId, service, state, enrolledAt, refreshedAt } = data;
	const label = optionalText(data.label, 64);
	const expirationTime = optionalText(data.expirationTime, 64);
	if (
		typeof subscriptionId !== 'string' ||
		!UUID.test(subscriptionId) ||
		!isText(service, 32) ||
		(state !== 'ACTIVE' && state !== 'EXPIRED') ||
		!isText(enrolledAt, 64) ||
		!isText(refreshedAt, 64) ||
		label === undefined ||
		expirationTime === undefined
	)
		return null;
	return { subscriptionId, label, service, state, enrolledAt, refreshedAt, expirationTime };
}

export function readPushDevices(data: unknown): PushDevice[] | null {
	if (!isRecord(data) || !Array.isArray(data.devices)) return null;
	const devices = data.devices.map(readPushDevice);
	return devices.every((device) => device !== null) ? (devices as PushDevice[]) : null;
}

const isStatus = (value: unknown): value is TestStatus =>
	TEST_STATUSES.includes(value as TestStatus);

export function readTestQueued(data: unknown): TestQueued | null {
	if (!isRecord(data)) return null;
	const { notificationId, status } = data;
	return typeof notificationId === 'string' && UUID.test(notificationId) && isStatus(status)
		? { notificationId, status }
		: null;
}

export function readTestNotification(data: unknown): TestNotification | null {
	if (!isRecord(data)) return null;
	const { notificationId, subscriptionId, status, attempts, queuedAt } = data;
	const lastAttemptAt = optionalText(data.lastAttemptAt, 64);
	const completedAt = optionalText(data.completedAt, 64);
	const failureReason = optionalText(data.failureReason, 64);
	const providerCode =
		data.providerCode === undefined || data.providerCode === null
			? null
			: Number.isInteger(data.providerCode)
				? (data.providerCode as number)
				: undefined;
	if (
		typeof notificationId !== 'string' ||
		!UUID.test(notificationId) ||
		typeof subscriptionId !== 'string' ||
		!UUID.test(subscriptionId) ||
		!isStatus(status) ||
		!Number.isInteger(attempts) ||
		!isText(queuedAt, 64) ||
		lastAttemptAt === undefined ||
		completedAt === undefined ||
		failureReason === undefined ||
		providerCode === undefined
	)
		return null;
	return {
		notificationId,
		subscriptionId,
		status,
		attempts: attempts as number,
		queuedAt,
		lastAttemptAt,
		completedAt,
		failureReason,
		providerCode
	};
}

/**
 * A device label as commerce stores it: trimmed, no control characters, at most LABEL_MAX
 * characters. Blank means none (null); anything else unusable is `undefined` (invalid).
 */
export function normalizeLabel(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') return undefined;
	const label = value.trim();
	if (!label) return null;
	return label.length <= LABEL_MAX && !/\p{Cc}/u.test(label) ? label : undefined;
}

const FAILURE_COPY: Record<NotificationFailureCode, string> = {
	unauthenticated: 'Your session has ended. Sign in again.',
	forbidden: 'Your account can’t use notifications.',
	not_found: 'That device or test is no longer available.',
	push_endpoint_in_use: 'This browser is still enrolled for another account.',
	IDEMPOTENCY_KEY_REUSED: 'That test was already sent to another device. Send a new test.',
	validation_failed: 'This browser’s subscription wasn’t accepted. Try enabling again.',
	push_notifications_disabled: 'Push notifications aren’t available right now.',
	unavailable: 'Notifications are unavailable right now. Try again shortly.'
};

/** Maps a commerce (or local) failure to our status, code and copy. */
export function notificationFailure(status: number, code: string | null): NotificationFailure {
	const mapped: NotificationFailureCode =
		status === 401
			? 'unauthenticated'
			: status === 403
				? 'forbidden'
				: status === 404
					? 'not_found'
					: status === 409 && code === 'push_endpoint_in_use'
						? 'push_endpoint_in_use'
						: status === 409 && code === 'IDEMPOTENCY_KEY_REUSED'
							? 'IDEMPOTENCY_KEY_REUSED'
							: status === 400 || status === 422
								? 'validation_failed'
								: status === 503 && code === 'push_notifications_disabled'
									? 'push_notifications_disabled'
									: 'unavailable';
	const statusFor: Record<NotificationFailureCode, number> = {
		unauthenticated: 401,
		forbidden: 403,
		not_found: 404,
		push_endpoint_in_use: 409,
		IDEMPOTENCY_KEY_REUSED: 409,
		validation_failed: 422,
		push_notifications_disabled: 503,
		unavailable: 503
	};
	return { status: statusFor[mapped], code: mapped, message: FAILURE_COPY[mapped] };
}

/** Reads one of our own failure envelopes (what the page receives from our endpoints). */
export function readFailure(status: number, data: unknown): NotificationFailure {
	const code = isRecord(data) && typeof data.code === 'string' ? data.code : null;
	return notificationFailure(status, code);
}

export const isTerminal = (status: TestStatus) =>
	status === 'push_accepted' || status === 'push_failed' || status === 'skipped';

const REASON_COPY: Record<string, string> = {
	subscription_expired: 'this device’s subscription has expired. Turn notifications on again.',
	subscription_revoked: 'this device was removed before the test went out.',
	recipient_not_eligible: 'your account can’t receive notifications right now.',
	provider_rejected: 'the push service refused it.',
	provider_unavailable: 'the push service was unavailable.',
	provider_throttled: 'the push service asked us to slow down.',
	transport_failure: 'the push service couldn’t be reached.',
	endpoint_not_allowed: 'this browser’s push service isn’t supported.',
	provider_outcome_unknown: 'the push service’s answer was lost.',
	delivery_expired: 'it couldn’t be delivered within ten minutes.'
};
const reasonCopy = (reason: string | null) =>
	(reason && REASON_COPY[reason]) || 'the push service didn’t take it.';

/** Plain wording for a test's current status. `push_accepted` is never presented as "shown". */
export function testStatusCopy(test: Pick<TestNotification, 'status' | 'failureReason'>): string {
	switch (test.status) {
		case 'queued':
			return 'Queued. Waiting for the push service…';
		case 'retrying':
			return `Retrying: ${reasonCopy(test.failureReason)}`;
		case 'push_accepted':
			return 'The push service accepted the test. That means it was handed off, not that it was shown.';
		case 'push_failed':
			return `Not delivered: ${reasonCopy(test.failureReason)}`;
		case 'skipped':
			return `Not sent: ${reasonCopy(test.failureReason)}`;
	}
}

const SERVICE_LABELS: Record<PushService, string> = {
	FCM: 'Google push service',
	MOZILLA: 'Mozilla push service',
	WINDOWS: 'Windows push service',
	APPLE: 'Apple push service',
	OTHER: 'Other push service'
};
export const serviceLabel = (service: string) =>
	SERVICE_LABELS[service as PushService] ?? SERVICE_LABELS.OTHER;
