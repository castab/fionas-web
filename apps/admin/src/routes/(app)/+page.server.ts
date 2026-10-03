import { dev } from '$app/environment';
import { formatToday } from '$lib/dashboard.js';
import { previewDashboard } from '$lib/dashboard-fixtures.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	return {
		todayLabel: formatToday(new Date()),
		// The API can't sort requests into the dashboard's groups yet, so the live page shows
		// placeholders. `?preview` (dev server only) fills them with sample data instead.
		preview: dev && url.searchParams.has('preview') ? previewDashboard() : null
	};
};
