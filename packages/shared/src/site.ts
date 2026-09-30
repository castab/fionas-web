/** Public business details. Rendered by both apps; keep in sync with the Instagram bio. */
export const site = {
	name: "Fiona's Ice Cream",
	url: 'https://www.fionasicecream.com',
	instagramHandle: 'fionasicecream',
	email: 'contact@fionasicecream.com',
	serviceArea: 'Fresno & Madera Ranchos'
} as const;

export const instagramUrl = `https://www.instagram.com/${site.instagramHandle}/`;
export const mailtoUrl = `mailto:${site.email}`;
