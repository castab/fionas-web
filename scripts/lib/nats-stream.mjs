// The JetStream stream the websites publish their events to, as code: its name, subjects and the
// configuration nats-setup.mjs creates or verifies. Pure (no connection), so it is unit-tested.
//
// Keep in sync with apps/public/src/lib/server/inquiry-event.ts and ../asyncapi.yaml (the tests
// check both).

/** The stream holding every inquiry event. */
export const STREAM = 'FIONAS_INQUIRIES';
/** Everything under `fionas.inquiries.` lands in it, so later event types and versions do too. */
export const SUBJECTS = ['fionas.inquiries.>'];
/** The one subject apps/public publishes (AsyncAPI channel `inquirySubmittedV1`). */
export const INQUIRY_SUBMITTED_SUBJECT = 'fionas.inquiries.submitted.v1';

const NS_PER_MS = 1_000_000;
const UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * JetStream drops a repeated Nats-Msg-Id inside this window. It matches the public site's 24-hour
 * replay window (FIONAS_REPLAY_SECRET envelopes), so "Try sending again" can never store one
 * submission twice.
 */
export const DUPLICATE_WINDOW_NS = UNITS_MS.d * NS_PER_MS;

/** `0` (keep forever), or a whole number of s/m/h/d, as nanoseconds. */
export function parseMaxAge(value) {
	if (value === undefined || value === '0') return 0;
	const match = /^([1-9][0-9]*)([smhd])$/.exec(String(value));
	if (!match) throw new Error(`Invalid --max-age "${value}": use 0, or e.g. 90d, 12h, 30m`);
	const ns = Number(match[1]) * UNITS_MS[match[2]] * NS_PER_MS;
	if (!Number.isSafeInteger(ns)) throw new Error(`--max-age "${value}" is too long`);
	if (ns < DUPLICATE_WINDOW_NS)
		throw new Error('--max-age must be at least 24h (the duplicate window)');
	return ns;
}

/** A replica count: 1 locally, typically 3 in a clustered deployment. */
export function parseReplicas(value) {
	const replicas = value === undefined ? 1 : Number(value);
	if (!Number.isInteger(replicas) || replicas < 1 || replicas > 5)
		throw new Error(`Invalid --replicas "${value}": use 1 to 5`);
	return replicas;
}

/**
 * The stream configuration (JetStream API field names). File storage and limits retention: events
 * stay until `max_age` (default: forever) for any number of independent consumers. Messages can't
 * be deleted one by one through the API, so the record is append-only.
 */
export function desiredStreamConfig({ replicas = 1, maxAge = 0 } = {}) {
	return {
		name: STREAM,
		description: "Fiona's inquiry events (see asyncapi.yaml)",
		subjects: [...SUBJECTS],
		storage: 'file',
		retention: 'limits',
		discard: 'old',
		max_age: maxAge,
		duplicate_window: DUPLICATE_WINDOW_NS,
		num_replicas: replicas,
		deny_delete: true
	};
}

/** The settings this repository manages. */
const MANAGED = [
	'subjects',
	'storage',
	'retention',
	'discard',
	'max_age',
	'duplicate_window',
	'num_replicas',
	'deny_delete'
];

/** Settings JetStream can't change on an existing stream: fixing them means a new stream. */
export const IMMUTABLE = new Set(['storage', 'retention']);

const normalize = (key, value) =>
	key === 'subjects' && Array.isArray(value) ? [...value].sort() : (value ?? null);

/** Every managed setting where `existing` differs from `desired`, as `{ key, existing, desired }`. */
export function diffStreamConfig(existing, desired) {
	return MANAGED.flatMap((key) => {
		const was = normalize(key, existing?.[key]);
		const want = normalize(key, desired[key]);
		return JSON.stringify(was) === JSON.stringify(want)
			? []
			: [{ key, existing: was, desired: want }];
	});
}

/** Nanoseconds as the largest whole unit ("24h", "90d"), or "forever" for 0. */
export function formatDuration(ns) {
	if (!ns) return 'forever';
	const ms = ns / NS_PER_MS;
	for (const unit of ['d', 'h', 'm', 's'])
		if (ms % UNITS_MS[unit] === 0) return `${ms / UNITS_MS[unit]}${unit}`;
	return `${ms}ms`;
}
