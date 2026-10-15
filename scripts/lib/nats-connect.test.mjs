import { describe, expect, it, vi } from 'vitest';

vi.mock('@nats-io/transport-node', () => ({ connect: vi.fn(), credsAuthenticator: vi.fn() }));
import { connect } from '@nats-io/transport-node';
import { connectAs, connectionSettings } from './nats-connect.mjs';

describe('token authentication', () => {
	it('uses env tokens and explicit auth overrides env credentials', () => {
		const env = { NATS_ADMIN_TOKEN: 'env-token', NATS_ADMIN_CREDS: 'operator.creds' };
		expect(connectionSettings({}, { NATS_ADMIN_TOKEN: 'env-token' })).toEqual({
			servers: ['nats://127.0.0.1:4222'],
			token: 'env-token'
		});
		expect(connectionSettings({ token: 'flag-token' }, env).token).toBe('flag-token');
		expect(connectionSettings({ user: 'ops', password: 'pass' }, env)).toMatchObject({
			user: 'ops',
			pass: 'pass'
		});
		expect(connectionSettings({}, env).creds).toBe('operator.creds');
	});

	it('does not default Docker credentials on a remote server', () => {
		expect(connectionSettings({ server: 'tls://dev.example:4222' }, {})).toEqual({
			servers: ['tls://dev.example:4222'],
			user: undefined,
			pass: undefined
		});
	});

	it('sends a token to the NATS client without username/password', async () => {
		await connectAs('test', { servers: ['tls://dev.example:4222'], token: 'secret' });
		expect(connect).toHaveBeenCalledWith({
			servers: ['tls://dev.example:4222'],
			name: 'test',
			timeout: 5000,
			maxReconnectAttempts: 0,
			token: 'secret'
		});
	});
});
