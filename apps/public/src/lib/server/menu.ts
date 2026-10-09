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
 * Code-owned menu and controls, laid out as the Booking design: "Your event" (contact, event and
 * guest count), the ice cream choices, then the optional note. There is no service duration.
 * Monetary amounts are supplied only by the server. Keys are stable: they name price-book entries
 * and submitted selections.
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
				label: 'About how many guests?',
				description: "A best guess is fine. We'll confirm when we follow up.",
				submissionPointer: '/serviceInputs/guestCount',
				required: true,
				input: { type: 'INTEGER', minimum: 1, maximum: 300, defaultValue: 50 },
				presentation: {
					control: 'STEPPER',
					step: 5,
					presets: [25, 50, 100, 200],
					summaryLabel: 'an estimated guest count',
					messages: {
						belowMinimum: 'Add a rough headcount so we can size your quote.',
						aboveMaximum:
							"We quote up to 300 online — for bigger crowds, add a note below and we'll plan it with you."
					}
				}
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
						item('hand-scooped-flavor', 'hand-scooped-chocolate-chip', 'Chocolate Chip'),
						item('hand-scooped-flavor', 'hand-scooped-chocolate', 'Chocolate'),
						item('hand-scooped-flavor', 'hand-scooped-mint-chip', 'Mint Chip'),
						item('hand-scooped-flavor', 'hand-scooped-butter-pecan', 'Butter Pecan', {
							infoNote: 'Contains tree nuts'
						}),
						item('hand-scooped-flavor', 'hand-scooped-vanilla-bean', 'Vanilla Bean'),
						item('hand-scooped-flavor', 'hand-scooped-strawberry', 'Strawberry'),
						item('hand-scooped-flavor', 'hand-scooped-cheesecake', 'Cheesecake', {
							unavailable: true,
							badge: 'Coming soon',
							statusNote: 'Creamy, dreamy, on its way!'
						})
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
						item('topping', 'rainbow-sprinkles', 'Rainbow Sprinkles'),
						item('topping', 'chocolate-sauce', 'Chocolate Sauce'),
						item('topping', 'caramel-sauce', 'Caramel Sauce'),
						item('topping', 'crushed-oreo', 'Crushed Oreo', {
							infoNote: 'Contains wheat & soy'
						}),
						item('topping', 'whipped-cream', 'Whipped Cream'),
						item('topping', 'sliced-almonds', 'Sliced Almonds', {
							infoNote: 'Contains tree nuts'
						}),
						item('topping', 'maraschino-cherries', 'Maraschino Cherries'),
						item('topping', 'gummy-bears', 'Gummy Bears'),
						item('topping', 'marshmallow-sauce', 'Marshmallow Sauce', {
							unavailable: true,
							badge: 'Coming soon',
							statusNote: 'Gooey goodness, almost here!'
						})
					]
				},
				presentation: { control: 'CHIPS', summaryLabel: 'at least 4 toppings' }
			},
			{
				key: 'offering:cone-option',
				label: 'Cones & cups — pick 1 or more',
				submissionPointer: '/serviceInputs/selections',
				required: true,
				input: {
					type: 'OFFERING_CHOICE',
					category: 'cone-option',
					minSelections: 1,
					maxSelections: 3,
					options: [
						item('cone-option', 'cup', 'Cups'),
						item('cone-option', 'sugar-cone', 'Sugar Cones'),
						item('cone-option', 'cake-cone', 'Cake Cones')
					]
				},
				presentation: { control: 'CHIPS', summaryLabel: 'at least 1 cone or cup' }
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
	'event.per_guest',
	'topping.extra_per_guest',
	...MENU_SECTIONS.flatMap((s) =>
		s.fields.flatMap((f) =>
			f.input.type === 'OFFERING_CHOICE' ? f.input.options.map((o) => o.priceKey!) : []
		)
	)
];
