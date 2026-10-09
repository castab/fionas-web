import type { InquiryFormSection, OfferingOption } from '@fionas/shared';

/** One menu item. Every item is priced per guest from its own private price-book key. */
function item(
	category: string,
	key: string,
	displayName: string,
	extra: Partial<Pick<OfferingOption, 'description' | 'badge' | 'statusNote' | 'infoNote'>> & {
		unavailable?: boolean;
	} = {}
): OfferingOption {
	const { unavailable, ...presentation } = extra;
	return {
		key,
		category,
		displayName,
		...presentation,
		selectionState: 'ENABLED',
		availability: unavailable ? 'UNAVAILABLE' : 'AVAILABLE',
		priceKey: `${category}.${key}`,
		pricingKind: 'PER_GUEST'
	};
}

/**
 * Code-owned menu and controls, laid out as the Booking design: "Your event" (contact, event,
 * guests and length), the ice cream choices, then the optional note. Monetary amounts are supplied
 * only by the server. Keys are stable: they name price-book entries and submitted selections.
 */
export const MENU_SECTIONS: InquiryFormSection[] = [
	{
		key: 'event',
		title: 'Your event',
		optional: false,
		fields: [
			{
				key: 'name',
				label: 'Your name',
				submissionPointer: '/name',
				required: true,
				input: { type: 'TEXT', minLength: 1, maxLength: 200 },
				presentation: { control: 'TEXT', placeholder: 'Fiona', summaryLabel: 'your name' }
			},
			{
				key: 'email',
				label: 'Email',
				submissionPointer: '/email',
				required: true,
				input: { type: 'EMAIL', maxLength: 254 },
				presentation: { control: 'TEXT', placeholder: 'you@example.com', summaryLabel: 'email' }
			},
			{
				key: 'zipCode',
				label: 'Event ZIP code',
				description: 'Used to check travel distance',
				submissionPointer: '/zipCode',
				required: true,
				input: { type: 'TEXT', minLength: 5, maxLength: 5, pattern: '^[0-9]{5}$' },
				presentation: { control: 'TEXT', placeholder: '93720', summaryLabel: 'event ZIP code' }
			},
			{
				key: 'eventDate',
				label: 'Event date',
				description: 'Weekends book fast!',
				submissionPointer: '/eventDate',
				required: true,
				input: { type: 'DATE', format: 'date' },
				presentation: { control: 'DATE', summaryLabel: 'event date' }
			},
			{
				key: 'eventType',
				label: 'Event type',
				submissionPointer: '/eventType',
				required: true,
				input: {
					type: 'STRING_CHOICE',
					options: [
						{ value: 'BIRTHDAY', label: 'Birthday' },
						{ value: 'WEDDING', label: 'Wedding' },
						{ value: 'CORPORATE', label: 'Corporate' },
						{ value: 'SCHOOL_EVENT', label: 'School event' },
						{ value: 'NEIGHBORHOOD_EVENT', label: 'Neighborhood event' },
						{ value: 'OTHER', label: 'Other' }
					]
				},
				presentation: { control: 'SELECT', summaryLabel: 'event type' }
			},
			{
				key: 'guestCount',
				label: 'How many guests?',
				description: "An estimate is fine — we'll confirm when we follow up.",
				submissionPointer: '/serviceInputs/guestCount',
				required: true,
				input: { type: 'INTEGER', minimum: 1 },
				presentation: { control: 'NUMBER', placeholder: '50', summaryLabel: 'guest count' }
			},
			{
				key: 'durationMinutes',
				label: 'How long should we scoop for?',
				description: "We'll confirm the exact start time when we follow up.",
				submissionPointer: '/serviceInputs/durationMinutes',
				required: true,
				input: {
					type: 'INTEGER_CHOICE',
					options: [
						{ value: 90, label: '1½ hours' },
						{ value: 120, label: '2 hours' },
						{ value: 150, label: '2½ hours' },
						{ value: 180, label: '3 hours' }
					]
				},
				presentation: { control: 'CHIPS', summaryLabel: 'service length' }
			}
		]
	},
	{
		key: 'service',
		title: 'Build your ice cream service',
		hideTitle: true,
		optional: false,
		fields: [
			{
				key: 'offering:soft-serve-flavor',
				label: 'Soft serve — pick 2',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'soft-serve-flavor',
					minSelections: 2,
					maxSelections: 2,
					options: [
						item('soft-serve-flavor', 'vanilla', 'Vanilla'),
						item('soft-serve-flavor', 'chocolate', 'Chocolate'),
						item('soft-serve-flavor', 'horchata', 'Horchata', {
							description: 'Premium soft serve'
						})
					]
				},
				presentation: { control: 'CHIPS', summaryLabel: '2 soft serve flavors' }
			},
			{
				key: 'offering:hand-scooped-flavor',
				label: 'Hand-scooped — pick 4',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'hand-scooped-flavor',
					minSelections: 4,
					maxSelections: 4,
					options: [
						item('hand-scooped-flavor', 'hand-scooped-chocolate-chip', 'Chocolate Chip', {
							infoNote: 'Contains milk'
						}),
						item('hand-scooped-flavor', 'hand-scooped-chocolate', 'Chocolate'),
						item('hand-scooped-flavor', 'hand-scooped-vanilla-bean', 'Vanilla Bean'),
						item('hand-scooped-flavor', 'hand-scooped-strawberry', 'Strawberry')
					]
				},
				presentation: { control: 'CHIPS', summaryLabel: '4 hand-scooped flavors' }
			},
			{
				key: 'offering:topping',
				label: 'Toppings — pick 4 to 6',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'topping',
					minSelections: 4,
					maxSelections: 6,
					options: [
						item('topping', 'sprinkles', 'Sprinkles'),
						item('topping', 'oreos', 'Oreos'),
						item('topping', 'strawberries', 'Strawberries'),
						item('topping', 'brownies', 'Brownies'),
						item('topping', 'gummy-bears', 'Gummy Bears', {
							unavailable: true,
							badge: 'Coming soon',
							statusNote: 'Back on the menu soon!'
						}),
						item('topping', 'cookie-dough', 'Cookie Dough')
					]
				},
				presentation: { control: 'CHIPS', summaryLabel: 'at least 4 toppings' }
			},
			{
				key: 'offering:cone-option',
				label: 'Cones & cups',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'cone-option',
					minSelections: 1,
					maxSelections: 1,
					options: [
						item('cone-option', 'cup', 'Cup'),
						item('cone-option', 'waffle-cone', 'Waffle cone')
					]
				},
				presentation: { control: 'CHIPS', summaryLabel: 'a cone or cup' }
			}
		]
	},
	{
		key: 'additional',
		title: 'Anything else',
		hideTitle: true,
		optional: true,
		fields: [
			{
				key: 'message',
				label: 'Anything else?',
				submissionPointer: '/message',
				required: false,
				input: { type: 'TEXT', minLength: 0, maxLength: 4000 },
				presentation: {
					control: 'TEXTAREA',
					placeholder: 'Parking notes, timing, favorite flavors we should know about…'
				}
			}
		]
	}
];

export const PRICE_KEYS = [
	'event.base',
	'event.hourly',
	'event.per_guest',
	'topping.extra_per_guest',
	...MENU_SECTIONS.flatMap((s) =>
		s.fields.flatMap((f) =>
			f.input.type === 'OFFERING_CHOICE' ? f.input.options.map((o) => o.priceKey!) : []
		)
	)
];
