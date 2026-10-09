import { INQUIRY_EVENT_TYPES, type CreateInquiryRequest } from '@fionas/shared';
export function isCreateInquiryRequest(value: unknown): value is CreateInquiryRequest {
	if (!value || typeof value !== 'object') return false;
	const v = value as CreateInquiryRequest;
	const text = (v: unknown): v is string => typeof v === 'string';
	const decimal = (v: unknown) => text(v) && /^[0-9]{1,9}(\.[0-9]{1,12})?$/.test(v);
	const minor = (v: unknown) => text(v) && /^[0-9]{1,9}(\.[0-9]{1,2})?$/.test(v);
	const units = (amount: string): bigint => {
		const [whole, fraction = ''] = amount.split('.');
		return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
	};
	return (
		[v.name, v.email, v.zipCode, v.eventDate].every(text) &&
		(v.message === undefined || text(v.message)) &&
		INQUIRY_EVENT_TYPES.includes(v.eventType) &&
		!!v.requestedService &&
		Number.isInteger(v.requestedService.guestCount) &&
		v.requestedService.guestCount > 0 &&
		v.requestedService.guestCount <= 100000 &&
		(v.requestedService.guestCountIsMinimum === undefined ||
			typeof v.requestedService.guestCountIsMinimum === 'boolean') &&
		(v.requestedService.durationMinutes === undefined ||
			(Number.isInteger(v.requestedService.durationMinutes) &&
				v.requestedService.durationMinutes > 0 &&
				v.requestedService.durationMinutes <= 1440)) &&
		Array.isArray(v.lines) &&
		v.lines.length > 0 &&
		v.lines.length <= 100 &&
		v.lines.every((l) => {
			if (
				!l ||
				typeof l !== 'object' ||
				Object.keys(l).some(
					(k) =>
						![
							'description',
							'subDescription',
							'quantity',
							'unitPrice',
							'taxAmount',
							'currency'
						].includes(k)
				) ||
				!text(l.description) ||
				!l.description.trim() ||
				l.description.length > 200 ||
				(l.subDescription !== undefined &&
					(!text(l.subDescription) || l.subDescription.length > 500)) ||
				!decimal(l.unitPrice) ||
				!minor(l.taxAmount) ||
				l.currency !== 'USD' ||
				(l.quantity !== undefined &&
					(!text(l.quantity) ||
						!/^[0-9]{1,9}(\.[0-9]{1,6})?$/.test(l.quantity) ||
						units(l.quantity) === 0n))
			)
				return false;
			const subtotal =
				l.quantity === undefined
					? units(l.unitPrice)
					: (units(l.unitPrice) * units(l.quantity)) / 10n ** 18n;
			return subtotal % 10n ** 16n === 0n;
		})
	);
}
