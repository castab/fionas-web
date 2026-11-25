/**
 * Which passkey provider (password manager, platform or security key) made a passkey, from the
 * AAGUID its authenticator reports at registration. Names are curated from the community
 * `passkey-authenticator-aaguids` list (passkeydeveloper on GitHub); only names are bundled, no
 * logos. An unknown or all-zero AAGUID (many security keys and `attestation: none` providers send
 * zeros) reads as a plain "Passkey". See docs/admin-passkeys.md.
 */
export type ProviderKind = 'password-manager' | 'platform' | 'security-key' | 'unknown';
export type PasskeyProvider = { name: string; kind: ProviderKind };

const managers: Record<string, string> = {
	'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
	'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Apple Passwords',
	'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'Apple Passwords (managed)',
	'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
	'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
	'531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
	'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
	'0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
	'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
	'50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
	'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
	'eaecdef2-1c31-5634-8639-f1cbd9c00a08': 'KeePassDX',
	'53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
	'b78a0a55-6ef8-d246-a042-ba0f6d55050c': 'LastPass',
	'd3452668-01fd-4c12-926c-83a4204853aa': 'Microsoft Password Manager',
	'b35a26b2-8f6e-4697-ab1d-d44db4da28c6': 'Zoho Vault',
	'de503f9c-21a4-4f76-b4b7-558eb55c6f89': 'Devolutions',
	'a10c6dd9-465e-4226-8198-c7c44b91c555': 'Kaspersky Password Manager',
	'fa37f553-f9b6-4adb-ac53-8bbb57ebdf0d': 'Norton Password Manager',
	'a4a2d88e-9796-4356-9164-e2a5a8bd019c': 'Avast Password Manager',
	'd9be9d39-e6a6-4c28-a581-32b044d986e4': 'Sticky Password'
};

const platforms: Record<string, string> = {
	'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
	'b5397666-4885-aa6b-cebf-e52262a439a2': 'Chromium browser',
	'771b48fd-d3d4-4f74-9232-fc157ab0507a': 'Edge on Mac',
	'08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
	'9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
	'6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello'
};

/** Yubico's published AAGUIDs for the YubiKey 5 and Bio series. */
const securityKeys: Record<string, string> = {
	'cb69481e-8ff7-4039-93ec-0a2729a154a8': 'YubiKey',
	'ee882879-721c-4913-9775-3dfcce97072a': 'YubiKey',
	'fa2b99dc-9e39-4257-8f92-4a30d23c4118': 'YubiKey',
	'2fc0579f-8113-47ea-b116-bb5a8db9202a': 'YubiKey',
	'c5ef55ff-ad9a-4b9f-b580-adebafe026d0': 'YubiKey',
	'73bb0cd4-e502-49b8-9c6f-b59445bf720b': 'YubiKey',
	'd8522d9f-575b-4866-88a9-ba99fa02f35b': 'YubiKey Bio'
};

const UNKNOWN: PasskeyProvider = { name: 'Passkey', kind: 'unknown' };

export function passkeyProvider(aaguid: string | null | undefined): PasskeyProvider {
	const key = aaguid?.toLowerCase();
	if (!key) return UNKNOWN;
	if (managers[key]) return { name: managers[key], kind: 'password-manager' };
	if (platforms[key]) return { name: platforms[key], kind: 'platform' };
	if (securityKeys[key]) return { name: securityKeys[key], kind: 'security-key' };
	return UNKNOWN;
}
