import type { InquiryFormSection } from '@fionas/shared';
/** Code-owned menu and controls. Monetary amounts are supplied only by the server. */
export const MENU_SECTIONS: InquiryFormSection[] = [
	{
		key: 'contact',
		title: 'Contact information',
		optional: false,
		fields: [
			{
				key: 'name',
				label: 'Your name',
				description: 'Tell us who we should address your inquiry to.',
				submissionPointer: '/name',
				required: true,
				input: {
					type: 'TEXT',
					minLength: 1,
					maxLength: 200
				},
				presentation: {
					control: 'TEXT'
				}
			},
			{
				key: 'email',
				label: 'Email address',
				description: "We'll use this address to follow up on your inquiry.",
				submissionPointer: '/email',
				required: true,
				input: {
					type: 'EMAIL',
					maxLength: 254
				},
				presentation: {
					control: 'TEXT'
				}
			},
			{
				key: 'zipCode',
				label: 'ZIP code',
				description:
					"Your event's five-digit ZIP code helps us review the service area and any travel surcharge.",
				submissionPointer: '/zipCode',
				required: true,
				input: {
					type: 'TEXT',
					minLength: 5,
					maxLength: 5,
					pattern: '^[0-9]{5}$'
				},
				presentation: {
					control: 'TEXT'
				}
			}
		]
	},
	{
		key: 'event',
		title: 'Event details',
		optional: false,
		fields: [
			{
				key: 'eventDate',
				label: 'Event date',
				description: 'What date is your event?',
				submissionPointer: '/eventDate',
				required: true,
				input: {
					type: 'DATE',
					format: 'date'
				},
				presentation: {
					control: 'DATE'
				}
			},
			{
				key: 'eventType',
				label: 'Event type',
				description: 'What kind of event are you planning?',
				submissionPointer: '/eventType',
				required: true,
				input: {
					type: 'STRING_CHOICE',
					options: [
						{
							value: 'BIRTHDAY',
							label: 'Birthday'
						},
						{
							value: 'WEDDING',
							label: 'Wedding'
						},
						{
							value: 'CORPORATE',
							label: 'Corporate'
						},
						{
							value: 'SCHOOL_EVENT',
							label: 'School event'
						},
						{
							value: 'NEIGHBORHOOD_EVENT',
							label: 'Neighborhood event'
						},
						{
							value: 'OTHER',
							label: 'Other'
						}
					]
				},
				presentation: {
					control: 'SELECT'
				}
			}
		]
	},
	{
		key: 'service',
		title: 'Build your ice cream service',
		description: 'Choose your guest count, service duration, and ice cream options.',
		optional: false,
		fields: [
			{
				key: 'guestCount',
				label: 'How many guests?',
				submissionPointer: '/serviceInputs/guestCount',
				required: true,
				input: {
					type: 'INTEGER',
					minimum: 1
				},
				presentation: {
					control: 'NUMBER'
				},
				description:
					'An estimate is totally okay - we can hash out the finer details during quoting.'
			},
			{
				key: 'durationMinutes',
				label: "How long are we scoopin'?",
				submissionPointer: '/serviceInputs/durationMinutes',
				required: true,
				input: {
					type: 'INTEGER_CHOICE',
					options: [
						{
							value: 90,
							label: '1½ hours'
						},
						{
							value: 120,
							label: '2 hours'
						},
						{
							value: 150,
							label: '2½ hours'
						},
						{
							value: 180,
							label: '3 hours'
						}
					]
				},
				presentation: {
					control: 'CHIPS'
				}
			},
			{
				key: 'offering:soft-serve-flavor',
				label: 'Choose your soft serve flavors',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'soft-serve-flavor',
					minSelections: 1,
					maxSelections: 2,
					options: [
						{
							key: 'vanilla',
							category: 'soft-serve-flavor',
							displayName: 'Vanilla',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'soft-serve-flavor.vanilla',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'chocolate',
							category: 'soft-serve-flavor',
							displayName: 'Chocolate',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'soft-serve-flavor.chocolate',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'horchata',
							category: 'soft-serve-flavor',
							displayName: 'Horchata',
							description: 'Premium soft serve',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'soft-serve-flavor.horchata',
							pricingKind: 'PER_GUEST'
						}
					]
				},
				presentation: {
					control: 'CHIPS'
				}
			},
			{
				key: 'offering:hand-scooped-flavor',
				label: 'Choose your hand-scooped flavors',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'hand-scooped-flavor',
					minSelections: 4,
					maxSelections: 4,
					options: [
						{
							key: 'hand-scooped-chocolate-chip',
							category: 'hand-scooped-flavor',
							displayName: 'Hand-scooped Chocolate Chip',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							badge: 'Crowd favorite',
							statusNote: 'On the menu',
							infoNote: 'Contains milk',
							priceKey: 'hand-scooped-flavor.hand-scooped-chocolate-chip',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'hand-scooped-chocolate',
							category: 'hand-scooped-flavor',
							displayName: 'Hand-scooped Chocolate',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'hand-scooped-flavor.hand-scooped-chocolate',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'hand-scooped-vanilla-bean',
							category: 'hand-scooped-flavor',
							displayName: 'Hand-scooped Vanilla Bean',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'hand-scooped-flavor.hand-scooped-vanilla-bean',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'hand-scooped-strawberry',
							category: 'hand-scooped-flavor',
							displayName: 'Hand-scooped Strawberry',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'hand-scooped-flavor.hand-scooped-strawberry',
							pricingKind: 'PER_GUEST'
						}
					]
				},
				presentation: {
					control: 'CHIPS'
				}
			},
			{
				key: 'offering:topping',
				label: 'Choose your toppings',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'topping',
					minSelections: 4,
					maxSelections: 6,
					options: [
						{
							key: 'sprinkles',
							category: 'topping',
							displayName: 'sprinkles',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'topping.sprinkles',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'oreos',
							category: 'topping',
							displayName: 'oreos',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'topping.oreos',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'strawberries',
							category: 'topping',
							displayName: 'strawberries',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'topping.strawberries',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'brownies',
							category: 'topping',
							displayName: 'brownies',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'topping.brownies',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'gummy-bears',
							category: 'topping',
							displayName: 'gummy-bears',
							selectionState: 'ENABLED',
							availability: 'UNAVAILABLE',
							priceKey: 'topping.gummy-bears',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'cookie-dough',
							category: 'topping',
							displayName: 'cookie-dough',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'topping.cookie-dough',
							pricingKind: 'PER_GUEST'
						}
					]
				},
				presentation: {
					control: 'CHIPS'
				}
			},
			{
				key: 'offering:cone-option',
				label: 'Choose your cones or cups',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'cone-option',
					minSelections: 1,
					maxSelections: 1,
					options: [
						{
							key: 'cup',
							category: 'cone-option',
							displayName: 'Cups',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'cone-option.cup',
							pricingKind: 'PER_GUEST'
						},
						{
							key: 'waffle-cone',
							category: 'cone-option',
							displayName: 'Waffle cones',
							selectionState: 'ENABLED',
							availability: 'AVAILABLE',
							priceKey: 'cone-option.waffle-cone',
							pricingKind: 'PER_GUEST'
						}
					]
				},
				presentation: {
					control: 'CHIPS'
				}
			}
		]
	},
	{
		key: 'additional',
		title: 'Additional information',
		optional: true,
		fields: [
			{
				key: 'message',
				label: 'Tell us about your event',
				description: 'Share the event location or anything else we should know.',
				submissionPointer: '/message',
				required: false,
				input: {
					type: 'TEXT',
					minLength: 0,
					maxLength: 4000
				},
				presentation: {
					control: 'TEXTAREA'
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
