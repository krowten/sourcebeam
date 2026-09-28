import type { Handle } from '@sveltejs/kit';

// The viewer is anonymous — access is granted by the signed invite cookie the Worker sets,
// not by a user account. This hook only carries the theme preference into the served HTML.
export const handle: Handle = async ({ event, resolve }) => {
	const dark = event.cookies.get('theme') === 'dark';
	return resolve(event, {
		transformPageChunk: ({ html }) =>
			dark ? html.replace('<html lang="en"', '<html lang="en" class="dark"') : html
	});
};
