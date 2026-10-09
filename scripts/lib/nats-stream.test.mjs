import { describe, expect, it } from 'vitest';
import {
	DUPLICATE_WINDOW_NS,
	INQUIRY_SUBMITTED_SUBJECT,
	STREAM,
	SUBJECTS,
	desiredStreamConfig,
	diffStreamConfig,
	formatDuration,
	parseMaxAge,
	parseReplicas
} from './nats-stream.mjs';
import { connectionSettings } from './nats-connect.mjs';

const DAY_NS = 24 * 60 * 60 * 1e9;

describe('desiredStreamConfig', () => {
	it('captures every inquiry subject with a 24-hour duplicate window', () => {
		const config = desiredStreamConfig();
		expect(config).toMatchObject({
			name: STREAM,
			subjects: SUBJECTS,
			storage: 'file',
			retention: 'limits',
			duplicate_window: DAY_NS,
			max_age: 0,
			num_replicas: 1,
			deny_delete: true
		});
		expect(DUPLICATE_WINDOW_NS).toBe(DAY_NS);
	});

	it('captures the subject the public site publishes', () => {
		const prefix = SUBJECTS[0].replace(/>$/, '');
		expect(INQUIRY_SUBMITTED_SUBJECT.startsWith(prefix)).toBe(true);
	});

	it('takes replicas and a maximum age', () => {
		expect(desiredStreamConfig({ replicas: 3, maxAge: 90 * DAY_NS })).toMatchObject({
			num_replicas: 3,
			max_age: 90 * DAY_NS
		});
	});
});

describe('diffStreamConfig', () => {
	it('finds nothing to change in a matching stream, whatever else it holds', () => {
		const desired = desiredStreamConfig();
		const existing = { ...desired, subjects: [...desired.subjects], max_msgs: -1, sealed: false };
		expect(diffStreamConfig(existing, desired)).toEqual([]);
	});

	it('reports each managed difference', () => {
		const desired = desiredStreamConfig();
		const existing = {
			...desired,
			subjects: ['fionas.inquiries.submitted.v1'],
			duplicate_window: 120 * 1e9,
			storage: 'memory'
		};
		expect(diffStreamConfig(existing, desired).map((d) => d.key)).toEqual([
			'subjects',
			'storage',
			'duplicate_window'
		]);
	});

	it('treats a missing setting as different', () => {
		const desired = desiredStreamConfig();
		const existing = { ...desired };
		delete existing.deny_delete;
		expect(diffStreamConfig(existing, desired)).toEqual([
			{ key: 'deny_delete', existing: null, desired: true }
		]);
	});
});

describe('flags', () => {
	it.each([
		[undefined, 0],
		['0', 0],
		['24h', DAY_NS],
		['90d', 90 * DAY_NS]
	])('max age %s', (value, ns) => expect(parseMaxAge(value)).toBe(ns));

	it.each(['12h', '1d1h', '-1d', 'forever', '90'])('refuses max age %s', (value) =>
		expect(() => parseMaxAge(value)).toThrow()
	);

	it.each(['0', '6', '1.5', 'three'])('refuses %s replicas', (value) =>
		expect(() => parseReplicas(value)).toThrow()
	);

	it('formats durations', () => {
		expect(formatDuration(0)).toBe('forever');
		expect(formatDuration(DAY_NS)).toBe('1d');
		expect(formatDuration(36 * 60 * 60 * 1e9)).toBe('36h');
	});
});

describe('connectionSettings', () => {
	it('defaults to the local compose server as its dev-only admin user', () => {
		expect(connectionSettings({}, {})).toEqual({
			servers: ['nats://127.0.0.1:4222'],
			user: 'fionas-admin',
			pass: 'fionas-admin-dev'
		});
	});

	it('prefers flags, then env, and a creds file over a password', () => {
		const env = { NATS_ADMIN_URL: 'nats://a:4222, nats://b:4222', NATS_ADMIN_USER: 'ops' };
		expect(connectionSettings({}, env)).toEqual({
			servers: ['nats://a:4222', 'nats://b:4222'],
			user: 'ops',
			pass: undefined
		});
		expect(connectionSettings({ creds: 'ops.creds' }, env)).toEqual({
			servers: ['nats://a:4222', 'nats://b:4222'],
			creds: 'ops.creds'
		});
		expect(connectionSettings({ server: 'nats://c:4222' }, env).servers).toEqual(['nats://c:4222']);
	});
});
