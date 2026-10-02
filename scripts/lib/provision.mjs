// Provisioning logic for SERVICE:fionas-web, separate from the CLI so it can be tested against a
// fake backend. Conservative by design: it creates what is missing, validates what exists, and
// refuses anything ambiguous or broader than this frontend needs. It never repairs, re-enables,
// removes or revokes; an operator fixes unexpected state deliberately.
//
// Backend facts this relies on (commerce-runtime): a service is identified by its UUID, and its
// name is only a non-blank label, so several services may share a name. Roles are global and may be
// assigned to many principals; replacing a role's permissions changes it for all of them. A
// service's current roles decide what its tokens may do, live. A credential grants nothing by
// itself, and its secret is returned only once, when it is created.

export const SERVICE_NAME = 'fionas-web';

export const ROLE = Object.freeze({
	key: 'fionas.web',
	displayName: 'Fiona web frontend',
	description: 'Public site: read the inquiry form, preview estimates, create inquiries',
	// Exactly these, never staff, offering-management, financial, role or credential permissions.
	permissions: Object.freeze([
		'fionas.inquiry-form.read',
		'fionas.estimate-preview.create',
		'fionas.inquiries.create'
	])
});

/** A failure the operator can act on; its message is safe to print (no secret ever goes in it). */
export class ProvisionError extends Error {}

/**
 * How a permission or role list differs from the expected set, compared as sets (order and
 * duplicates don't matter).
 */
export function compareSets(expected, actual) {
	const want = new Set(expected);
	const have = new Set(actual);
	const missing = [...want].filter((item) => !have.has(item));
	const unexpected = [...have].filter((item) => !want.has(item));
	return { equal: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

const list = (items) => (items.length > 0 ? items.join(', ') : '(none)');

/** The one service named SERVICE_NAME, or null; several are ambiguous and refused. */
function matchingService(services) {
	const matches = services.filter((service) => service.name === SERVICE_NAME);
	if (matches.length > 1) {
		throw new ProvisionError(
			`${matches.length} services are named "${SERVICE_NAME}" (${matches.map((s) => s.id).join(', ')}). ` +
				'A name is only a label, so the script will not pick one. Decide which service the public ' +
				'site should use, disable or rename the others, then run it again.'
		);
	}
	return matches[0] ?? null;
}

function assertActive(service) {
	if (service.status !== 'ACTIVE') {
		throw new ProvisionError(
			`Service "${SERVICE_NAME}" (${service.id}) is ${service.status}, not ACTIVE. The script won't ` +
				`re-enable it: check why it was disabled, then PUT /admin/access/services/${service.id}/status ` +
				'if it should be active again.'
		);
	}
}

/** The service may hold `fionas.web` and nothing else; anything else is refused, never removed. */
function assertOnlyWebRole(service, roles, { requireWebRole }) {
	const unexpected = roles.filter((role) => role !== ROLE.key);
	if (unexpected.length > 0) {
		throw new ProvisionError(
			`Service "${SERVICE_NAME}" (${service.id}) has roles beyond ${ROLE.key}: ${unexpected.join(', ')}. ` +
				`The public site's service must hold exactly ${ROLE.key}. Inspect it and remove the extra ` +
				`role assignments deliberately (DELETE /admin/access/services/${service.id}/roles/{roleKey}), ` +
				'or use a different service, then run the script again. No credential was created.'
		);
	}
	if (requireWebRole && !roles.includes(ROLE.key)) {
		throw new ProvisionError(
			`Service "${SERVICE_NAME}" (${service.id}) does not hold ${ROLE.key} after assignment. ` +
				'No credential was created.'
		);
	}
}

/** `fionas.web` must grant exactly ROLE.permissions; a different role is a conflict, not a fix-up. */
function assertRoleGrants(role) {
	const diff = compareSets(ROLE.permissions, role.permissions ?? []);
	if (diff.equal) return;
	throw new ProvisionError(
		[
			`Role ${ROLE.key} exists with different permissions, so the script stopped.`,
			`  expected:   ${list([...ROLE.permissions])}`,
			`  actual:     ${list(role.permissions ?? [])}`,
			`  missing:    ${list(diff.missing)}`,
			`  unexpected: ${list(diff.unexpected)}`,
			'Roles are global: changing this one changes what every principal assigned to it may do. ' +
				'Review who holds it (GET /admin/access/services, GET /admin/access/users) and correct it ' +
				'deliberately, then run the script again. No credential was created.'
		].join('\n')
	);
}

/**
 * Makes sure SERVICE:fionas-web exists as a dedicated, active, least-privilege principal, then
 * issues a credential for it.
 *
 * Order: every read and check that can fail comes before any change; the changes only add what is
 * missing (role, service, assignment); the result is read back and checked again; only then is a
 * credential minted. So a run that stops on a conflict never leaves a new credential behind.
 *
 * - `api(method, route, body?)` returns the response data or throws a ProvisionError.
 * - `confirm(question, { defaultYes })` asks the operator (before adding another credential).
 * - `log(message)` reports progress. Nothing secret is ever passed to it.
 *
 * Returns `{ serviceId, issued, previous }` (`issued` holds the secret), or `{ serviceId, issued:
 * null, previous }` when the operator declined to add another credential.
 */
export async function provisionService({ api, confirm, log = () => {} }) {
	// 1. Read and validate everything that already exists.
	const { services } = await api('GET', '/admin/access/services');
	const existing = matchingService(services);
	if (existing) {
		assertActive(existing);
		const { roles } = await api('GET', `/admin/access/services/${existing.id}/roles`);
		assertOnlyWebRole(existing, roles, { requireWebRole: false });
		log(`Service "${SERVICE_NAME}" already exists (${existing.id}).`);
	}

	const { roles: definitions } = await api('GET', '/admin/access/roles');
	const role = definitions.find((definition) => definition.key === ROLE.key);
	if (role) {
		assertRoleGrants(role);
		log(`Role ${ROLE.key} already grants exactly its ${ROLE.permissions.length} permissions.`);
	}

	// 2. Add only what is missing.
	if (!role) {
		await api('POST', '/admin/access/roles', { ...ROLE, permissions: [...ROLE.permissions] });
		log(`Created role ${ROLE.key} with exactly ${ROLE.permissions.length} permissions.`);
	}
	let serviceId = existing?.id;
	if (!existing) {
		const created = await api('POST', '/admin/access/services', { name: SERVICE_NAME });
		serviceId = created.id;
		log(`Created service "${SERVICE_NAME}" (${serviceId}).`);
	}
	const { roles: assigned } = await api('GET', `/admin/access/services/${serviceId}/roles`);
	if (!assigned.includes(ROLE.key)) {
		await api('PUT', `/admin/access/services/${serviceId}/roles/${ROLE.key}`);
		log(`Assigned role ${ROLE.key} to the service.`);
	}

	// 3. Read back the state the credential will depend on, and check it again.
	const service = await api('GET', `/admin/access/services/${serviceId}`);
	assertActive(service);
	const { roles: finalRoles } = await api('GET', `/admin/access/services/${serviceId}/roles`);
	assertOnlyWebRole(service, finalRoles, { requireWebRole: true });
	assertRoleGrants(await api('GET', `/admin/access/roles/${ROLE.key}`));

	// 4. Only now: a credential. Existing ones keep working; nothing is revoked.
	const route = `/admin/access/services/${serviceId}/credentials`;
	const { credentials } = await api('GET', route);
	const previous = credentials
		.filter((credential) => !credential.revoked)
		.map((c) => c.credentialId);
	if (previous.length > 0) {
		const another = await confirm(
			`The service already has ${previous.length} active credential${previous.length === 1 ? '' : 's'} ` +
				'(a new one is added; the old ones keep working until you revoke them). Create another?',
			{ defaultYes: true }
		);
		if (!another) return { serviceId, issued: null, previous };
	}
	const label = `${SERVICE_NAME} ${new Date().toISOString().slice(0, 10)}`;
	const issued = await api('POST', route, { label });
	if (typeof issued?.secret !== 'string' || !issued.secret) {
		throw new ProvisionError(`POST ${route} returned no secret.`);
	}
	return { serviceId: issued.serviceId ?? serviceId, issued, previous };
}
