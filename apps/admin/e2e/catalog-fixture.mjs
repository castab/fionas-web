// Test-only catalog, inquiry-form and pricing facts for the quote builder. The application never
// imports these: it reads names, limits, availability and durations from the API at runtime.

export const catalogRevision = 15;

/** @param {string} key @param {string} category @param {string} displayName @param {Record<string, unknown>} [extra] */
const offering = (key, category, displayName, extra = {}) => ({
	key,
	category,
	displayName,
	description: null,
	selectionState: 'ENABLED',
	availability: 'AVAILABLE',
	badge: null,
	statusNote: null,
	infoNote: null,
	...extra
});
/** @param {string} amount */
const perGuest = (amount) => ({
	kind: 'PER_QUANTITY',
	amount,
	currency: 'USD',
	dimension: 'guest'
});

/** @param {number} [revision] */
export function offeringCatalog(revision = catalogRevision) {
	return {
		catalogId: 'fionas',
		revision,
		previousRevision: revision - 1,
		categories: [
			{
				key: 'soft-serve-flavor',
				displayName: 'Soft serve',
				description: null,
				minimumSelections: 1,
				maximumSelections: 2,
				offerings: [
					offering('vanilla', 'soft-serve-flavor', 'Vanilla'),
					offering('chocolate', 'soft-serve-flavor', 'Chocolate'),
					offering('horchata', 'soft-serve-flavor', 'Horchata', { price: perGuest('0.50') })
				]
			},
			{
				key: 'hand-scooped-flavor',
				displayName: 'Hand-scooped',
				description: null,
				minimumSelections: 4,
				maximumSelections: 4,
				offerings: [
					offering('hand-scooped-chocolate-chip', 'hand-scooped-flavor', 'Chocolate Chip'),
					offering('hand-scooped-strawberry', 'hand-scooped-flavor', 'Strawberry'),
					offering('hand-scooped-mint-chip', 'hand-scooped-flavor', 'Mint Chip'),
					offering('hand-scooped-vanilla-bean', 'hand-scooped-flavor', 'Vanilla Bean'),
					offering('hand-scooped-butter-pecan', 'hand-scooped-flavor', 'Butter Pecan', {
						availability: 'UNAVAILABLE',
						badge: 'Out today',
						statusNote: 'Our supplier is out this week.'
					}),
					offering('hand-scooped-rocky-road', 'hand-scooped-flavor', 'Rocky Road', {
						selectionState: 'DISABLED'
					})
				]
			},
			{
				key: 'topping',
				displayName: 'Toppings',
				description: null,
				minimumSelections: 4,
				maximumSelections: 6,
				offerings: [
					offering('sprinkles', 'topping', 'Rainbow sprinkles'),
					offering('oreos', 'topping', 'Crushed Oreo'),
					offering('strawberries', 'topping', 'Strawberries'),
					offering('brownies', 'topping', 'Brownies'),
					offering('hot-fudge', 'topping', 'Hot fudge'),
					offering('gummy-bears', 'topping', 'Gummy bears', { availability: 'UNAVAILABLE' })
				]
			},
			{
				key: 'cone-option',
				displayName: 'Cones & cups',
				description: null,
				minimumSelections: 1,
				maximumSelections: 1,
				offerings: [
					offering('cup', 'cone-option', 'Cups & cake cones'),
					offering('waffle-cone', 'cone-option', 'Waffle cones', { price: perGuest('0.75') })
				]
			}
		]
	};
}

export const durations = [
	{ value: 90, label: '1½ hours' },
	{ value: 120, label: '2 hours' },
	{ value: 150, label: '2½ hours' },
	{ value: 180, label: '3 hours' }
];

/** Only the pricing questions the admin builder reads. @param {number} [revision] */
export function inquiryForm(revision = catalogRevision) {
	return {
		definitionVersion: 11,
		catalogId: 'fionas',
		catalogRevision: revision,
		sections: [
			{
				key: 'service',
				title: 'Your service',
				optional: false,
				fields: [
					{
						key: 'guestCount',
						label: 'How many guests?',
						submissionPointer: '/pricingInputs/guestCount',
						required: true,
						input: { type: 'INTEGER', minimum: 1 },
						presentation: { control: 'NUMBER' }
					},
					{
						key: 'durationMinutes',
						label: 'How long are we scoopin’?',
						submissionPointer: '/pricingInputs/durationMinutes',
						required: true,
						input: { type: 'INTEGER_CHOICE', options: durations },
						presentation: { control: 'CHIPS' }
					}
				]
			}
		],
		pricingPreview: {
			currency: 'USD',
			guestQuantityDimension: 'guest',
			durationOptions: [],
			perGuestAmount: '4.50',
			toppingAdjustment: {
				category: 'topping',
				includedSelections: 4,
				additionalSelectionPerGuestAmount: '0.50'
			}
		}
	};
}

/** Fixture-only policy that reproduces the request fixtures' $415 Estimate for Maya. */
export const stubPricing = {
	base: /** @type {Record<number, string>} */ ({
		90: '205.00',
		120: '250.00',
		150: '275.00',
		180: '300.00'
	}),
	perGuest: '4.50',
	toppingCategory: 'topping',
	includedToppings: 4,
	extraTopping: '0.50'
};
