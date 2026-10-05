import { describe, expect, it } from 'vitest';
import { greetingName, initials, roleLabel, staffHandle } from './staff.js';

describe('staff names', () => {
	it('greets by first name, lowercased', () => {
		expect(greetingName({ username: 'fiona', displayName: 'Fiona C.', firstName: 'Fiona' })).toBe(
			'fiona'
		);
		expect(greetingName({ username: 'brayan', displayName: 'Brayan Castaneda' })).toBe('brayan');
		expect(greetingName({ username: 'ana', displayName: '  ' })).toBe('ana');
	});

	it('builds up to two initials', () => {
		expect(
			initials({ username: 'f', displayName: 'x', firstName: 'Fiona', lastName: 'Castaneda' })
		).toBe('FC');
		expect(initials({ username: 'f', displayName: 'x', firstName: 'fiona' })).toBe('F');
		expect(initials({ username: 'b', displayName: 'Brayan de la Cruz' })).toBe('BD');
		expect(initials({ username: 'brayan', displayName: '' })).toBe('B');
	});

	it('shows the handle and a readable role', () => {
		expect(staffHandle({ username: 'brayan' })).toBe('@brayan');
		expect(roleLabel(['commerce.administrator'])).toBe('Administrator');
		expect(roleLabel(['front_desk'])).toBe('Front desk');
		expect(roleLabel([])).toBe('Staff');
	});
});
