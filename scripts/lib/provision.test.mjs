import { describe, expect, it, vi } from 'vitest';
import { ProvisionError, ROLE, SERVICE_NAME, compareSets, provisionService } from './provision.mjs';

/*
 * The provisioning logic against an in-memory stand-in for fionas-commerce's /admin/access API. It
 * records every call, so each test can say exactly what was (and wasn't) changed, and above all
 * whether a credential was minted.
 */

const SERVICE_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ID = '00000000-0000-4000-8000-0000000000b2';
const SECRET = 'test-only-issued-secret';
const WEB_ROLE = { key: ROLE.key, displayName: 'Web', permissions: [...ROLE.permissions] };

function fakeAccess({ services = [], roles = [], credentials = {} } = {}) {
	const state = {
		services: new Map(services.map((s) => [s.id, { ...s, roles: [...(s.roles ?? [])] }])),
		roles: new Map(roles.map((r) => [r.key, { ...r, permissions: [...r.permissions] }])),
		credentials: new Map(Object.entries(credentials))
	};
	const calls = [];
	let created = 0;

	const notFound = (route) => {
		throw new ProvisionError(`${route} → 404`);
	};
	const serviceOf = (id, route) => state.services.get(id) ?? notFound(route);
	const view = (s) => ({ id: s.id, name: s.name, status: s.status, roles: [...s.roles] });

	async function api(method, route, body) {
		calls.push({ method, route, body });
		let m;
		if (method === 'GET' && route === '/admin/access/services') {
			return { services: [...state.services.values()].map(view) };
		}
		if (method === 'POST' && route === '/admin/access/services') {
			created += 1;
			const id = `00000000-0000-4000-8000-${String(created).padStart(12, 'c')}`;
			state.services.set(id, { id, name: body.name, status: 'ACTIVE', roles: [] });
			return view(state.services.get(id));
		}
		if ((m = /^\/admin\/access\/services\/([^/]+)$/.exec(route)) && method === 'GET') {
			return view(serviceOf(m[1], route));
		}
		if ((m = /^\/admin\/access\/services\/([^/]+)\/roles$/.exec(route)) && method === 'GET') {
			return { roles: [...serviceOf(m[1], route).roles] };
		}
		if (
			(m = /^\/admin\/access\/services\/([^/]+)\/roles\/([^/]+)$/.exec(route)) &&
			method === 'PUT'
		) {
			const service = serviceOf(m[1], route);
			if (!state.roles.has(m[2])) notFound(route);
			if (!service.roles.includes(m[2])) service.roles.push(m[2]);
			return null;
		}
		if (method === 'GET' && route === '/admin/access/roles') {
			return { roles: [...state.roles.values()] };
		}
		if (method === 'POST' && route === '/admin/access/roles') {
			state.roles.set(body.key, { ...body, permissions: [...body.permissions] });
			return body;
		}
		if ((m = /^\/admin\/access\/roles\/([^/]+)$/.exec(route)) && method === 'GET') {
			return state.roles.get(m[1]) ?? notFound(route);
		}
		if ((m = /^\/admin\/access\/roles\/([^/]+)\/permissions$/.exec(route)) && method === 'PUT') {
			state.roles.get(m[1]).permissions = [...body.permissions];
			return state.roles.get(m[1]);
		}
		if ((m = /^\/admin\/access\/services\/([^/]+)\/credentials$/.exec(route))) {
			serviceOf(m[1], route);
			const list = state.credentials.get(m[1]) ?? [];
			if (method === 'GET') return { credentials: list };
			const credentialId = `credential-${list.length + 1}`;
			state.credentials.set(m[1], [...list, { credentialId, revoked: false }]);
			return { credentialId, serviceId: m[1], label: body.label, secret: SECRET };
		}
		throw new Error(`unexpected ${method} ${route}`);
	}

	const writes = () => calls.filter((c) => c.method !== 'GET');
	return {
		api,
		state,
		calls,
		writes,
		mints: () => calls.filter((c) => c.method === 'POST' && c.route.endsWith('/credentials')),
		revocations: () => calls.filter((c) => c.method === 'DELETE'),
		roleReplacements: () => calls.filter((c) => c.route.endsWith('/permissions'))
	};
}

const service = (overrides = {}) => ({
	id: SERVICE_ID,
	name: SERVICE_NAME,
	status: 'ACTIVE',
	roles: [ROLE.key],
	...overrides
});

const run = (backend, confirm = vi.fn(async () => true)) =>
	provisionService({ api: backend.api, confirm });

/** Runs and expects a refusal that wrote nothing and minted nothing. */
async function expectRefusal(backend, message) {
	await expect(run(backend)).rejects.toThrow(message);
	expect(backend.writes()).toEqual([]);
	expect(backend.mints()).toEqual([]);
}

describe('service identity', () => {
	it('creates the service, the role and the assignment when none exist, then mints', async () => {
		const backend = fakeAccess();
		const result = await run(backend);

		const [created] = [...backend.state.services.values()];
		expect(created).toMatchObject({ name: SERVICE_NAME, status: 'ACTIVE', roles: [ROLE.key] });
		expect(backend.state.roles.get(ROLE.key)?.permissions).toEqual([...ROLE.permissions]);
		expect(result).toMatchObject({
			serviceId: created.id,
			issued: { secret: SECRET },
			previous: []
		});
		expect(backend.mints()).toHaveLength(1);
	});

	it('reuses exactly one ACTIVE service that holds only fionas.web', async () => {
		const backend = fakeAccess({ services: [service()], roles: [WEB_ROLE] });
		const result = await run(backend);

		expect(result.serviceId).toBe(SERVICE_ID);
		expect(backend.writes().map((c) => `${c.method} ${c.route}`)).toEqual([
			`POST /admin/access/services/${SERVICE_ID}/credentials`
		]);
	});

	it('assigns fionas.web to an existing service that has no roles yet', async () => {
		const backend = fakeAccess({ services: [service({ roles: [] })], roles: [WEB_ROLE] });
		await run(backend);
		expect(backend.state.services.get(SERVICE_ID)?.roles).toEqual([ROLE.key]);
	});

	it('refuses several services with the same name and picks none', async () => {
		const backend = fakeAccess({
			services: [service(), service({ id: OTHER_ID })],
			roles: [WEB_ROLE]
		});
		await expectRefusal(backend, `2 services are named "${SERVICE_NAME}"`);
		await expect(run(backend)).rejects.toThrow(`${SERVICE_ID}, ${OTHER_ID}`);
	});

	it('refuses a DISABLED service and does not re-enable it', async () => {
		const backend = fakeAccess({ services: [service({ status: 'DISABLED' })], roles: [WEB_ROLE] });
		await expectRefusal(backend, /is DISABLED, not ACTIVE/);
	});

	it('refuses a service holding fionas.web plus another role, without removing it', async () => {
		const backend = fakeAccess({
			services: [service({ roles: [ROLE.key, 'commerce.administrator'] })],
			roles: [WEB_ROLE]
		});
		await expectRefusal(backend, /roles beyond fionas\.web: commerce\.administrator/);
		expect(backend.state.services.get(SERVICE_ID)?.roles).toContain('commerce.administrator');
	});

	it('refuses a service holding a different role instead of fionas.web', async () => {
		const backend = fakeAccess({
			services: [service({ roles: ['commerce.manager'] })],
			roles: [WEB_ROLE]
		});
		await expectRefusal(backend, /roles beyond fionas\.web: commerce\.manager/);
	});

	it('ignores services with other names', async () => {
		const backend = fakeAccess({
			services: [service({ id: OTHER_ID, name: 'fionas-web-old', roles: ['x'] })],
			roles: [WEB_ROLE]
		});
		const result = await run(backend);
		expect(result.serviceId).not.toBe(OTHER_ID);
	});
});

describe('role safety', () => {
	it('creates a missing fionas.web with exactly the three grants', async () => {
		const backend = fakeAccess({ services: [service({ roles: [] })] });
		await run(backend);
		const create = backend.calls.find(
			(c) => c.method === 'POST' && c.route === '/admin/access/roles'
		);
		expect(create?.body.key).toBe(ROLE.key);
		expect([...create.body.permissions].sort()).toEqual([...ROLE.permissions].sort());
	});

	it('leaves an existing role with exactly the expected grants unchanged', async () => {
		const backend = fakeAccess({ services: [service()], roles: [WEB_ROLE] });
		await run(backend);
		expect(backend.roleReplacements()).toEqual([]);
		expect(
			backend.calls.some((c) => c.method === 'POST' && c.route === '/admin/access/roles')
		).toBe(false);
	});

	it('compares grants as sets, not lists', async () => {
		const reordered = { ...WEB_ROLE, permissions: [...ROLE.permissions].reverse() };
		const backend = fakeAccess({ services: [service()], roles: [reordered] });
		await expect(run(backend)).resolves.toMatchObject({ issued: { secret: SECRET } });
		expect(compareSets(['a', 'b'], ['b', 'a', 'a'])).toEqual({
			equal: true,
			missing: [],
			unexpected: []
		});
	});

	it('refuses a role with an extra grant and never replaces it', async () => {
		const backend = fakeAccess({
			services: [service()],
			roles: [{ ...WEB_ROLE, permissions: [...ROLE.permissions, 'fionas.inquiries.read'] }]
		});
		await expectRefusal(backend, /unexpected: fionas\.inquiries\.read/);
		expect(backend.roleReplacements()).toEqual([]);
	});

	it('refuses a role missing a grant and never replaces it', async () => {
		const backend = fakeAccess({
			services: [service()],
			roles: [{ ...WEB_ROLE, permissions: ROLE.permissions.slice(0, 2) }]
		});
		await expect(run(backend)).rejects.toThrow(
			/expected: .*\n {2}actual: .*\n {2}missing: {4}fionas\.inquiries\.create\n {2}unexpected: \(none\)/
		);
		expect(backend.roleReplacements()).toEqual([]);
		expect(backend.mints()).toEqual([]);
	});

	it('says why a global role is not changed', async () => {
		const backend = fakeAccess({ roles: [{ ...WEB_ROLE, permissions: [] }] });
		await expectRefusal(backend, /Roles are global/);
		// Nothing was created either: the conflict was found before any change.
		expect(backend.state.services.size).toBe(0);
	});
});

describe('credential ordering', () => {
	it('mints only after every check, as the last write', async () => {
		const backend = fakeAccess();
		await run(backend);
		const mintIndex = backend.calls.findIndex(
			(c) => c.method === 'POST' && c.route.endsWith('/credentials')
		);
		expect(mintIndex).toBe(backend.calls.length - 1);
		const verified = backend.calls.slice(0, mintIndex).map((c) => `${c.method} ${c.route}`);
		const id = [...backend.state.services.keys()][0];
		// The state the credential depends on was read back after the changes.
		expect(verified.slice(-4)).toEqual([
			`GET /admin/access/services/${id}`,
			`GET /admin/access/services/${id}/roles`,
			`GET /admin/access/roles/${ROLE.key}`,
			`GET /admin/access/services/${id}/credentials`
		]);
	});

	it('mints nothing if the state read back is wrong (changed concurrently)', async () => {
		const backend = fakeAccess({ services: [service({ roles: [] })], roles: [WEB_ROLE] });
		const api = backend.api;
		backend.api = async (method, route, body) => {
			const result = await api(method, route, body);
			// Someone else grants the service an admin role right after our assignment.
			if (method === 'PUT' && route.endsWith(`/roles/${ROLE.key}`)) {
				backend.state.services.get(SERVICE_ID).roles.push('commerce.administrator');
			}
			return result;
		};
		await expect(run(backend)).rejects.toThrow(/roles beyond fionas\.web/);
		expect(backend.mints()).toEqual([]);
	});
});

describe('re-runs and rotation', () => {
	it('issues a credential for a correct setup without active credentials, without asking', async () => {
		const backend = fakeAccess({
			services: [service()],
			roles: [WEB_ROLE],
			credentials: { [SERVICE_ID]: [{ credentialId: 'old', revoked: true }] }
		});
		const confirm = vi.fn(async () => false);
		const result = await run(backend, confirm);
		expect(confirm).not.toHaveBeenCalled();
		expect(result.issued?.secret).toBe(SECRET);
		expect(result.previous).toEqual([]);
	});

	it('asks before adding another credential and adds nothing when declined', async () => {
		const backend = fakeAccess({
			services: [service()],
			roles: [WEB_ROLE],
			credentials: { [SERVICE_ID]: [{ credentialId: 'current', revoked: false }] }
		});
		const confirm = vi.fn(async () => false);
		const result = await run(backend, confirm);
		expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/1 active credential/), {
			defaultYes: true
		});
		expect(result).toEqual({ serviceId: SERVICE_ID, issued: null, previous: ['current'] });
		expect(backend.mints()).toEqual([]);
	});

	it('adds a credential alongside the existing ones and never revokes any', async () => {
		const backend = fakeAccess({
			services: [service()],
			roles: [WEB_ROLE],
			credentials: { [SERVICE_ID]: [{ credentialId: 'current', revoked: false }] }
		});
		const result = await run(backend);
		expect(result.previous).toEqual(['current']);
		expect(backend.state.credentials.get(SERVICE_ID)).toEqual([
			{ credentialId: 'current', revoked: false },
			{ credentialId: 'credential-2', revoked: false }
		]);
		expect(backend.revocations()).toEqual([]);
	});

	it('is safe to run twice', async () => {
		const backend = fakeAccess();
		await run(backend);
		await run(backend);
		expect(backend.state.services.size).toBe(1);
		expect(backend.mints()).toHaveLength(2);
		expect(backend.roleReplacements()).toEqual([]);
	});

	it('never puts the secret in its progress log', async () => {
		const backend = fakeAccess();
		const log = vi.fn();
		await provisionService({ api: backend.api, confirm: async () => true, log });
		expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
	});
});
