/**
 * How the signed-in staff member is named in the console. Structural types, so client code never
 * imports `$lib/server`.
 */
export type StaffName = {
	username: string;
	displayName: string;
	firstName?: string;
	lastName?: string;
};

function words(text: string): string[] {
	return text.trim().split(/\s+/).filter(Boolean);
}

/** The dashboard's "hi, …": the first name, lowercased like the rest of the headings. */
export function greetingName(user: StaffName): string {
	const first = user.firstName?.trim() || words(user.displayName)[0] || user.username;
	return first.toLowerCase();
}

/** Up to two initials for the avatar: first + last name, else the display name's words. */
export function initials(user: StaffName): string {
	const first = user.firstName?.trim();
	const last = user.lastName?.trim();
	const parts = first ? [first, last ?? ''] : words(user.displayName);
	const letters = parts
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part.charAt(0).toUpperCase())
		.join('');
	return letters || user.username.charAt(0).toUpperCase();
}

export function staffHandle(user: Pick<StaffName, 'username'>): string {
	return `@${user.username}`;
}

/**
 * A readable label for the first role key: `commerce.administrator` → "Administrator". A stand-in
 * until the role's display name is read from the backend (see docs/admin-dashboard-report.md).
 */
export function roleLabel(roles: string[]): string {
	const key = roles[0];
	if (!key) return 'Staff';
	const last = key.split('.').pop() ?? key;
	const label = last.replace(/[-_]+/g, ' ').trim();
	return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Staff';
}
