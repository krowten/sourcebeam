import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				experimental: { async: true }
			},
			// `main` in the real wrangler.jsonc is our custom src/worker.ts (DO export + /ws
			// routing); point the adapter at a build-only config without `main` so it writes
			// its generated worker to the default `.svelte-kit/cloudflare/_worker.js` instead
			// of clobbering src/worker.ts.
			adapter: adapter({ config: 'wrangler.build.jsonc' }),
			experimental: {
				remoteFunctions: true,
				forkPreloads: true
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					// src/worker/** runs in the separate workers pool (test:do), not the node vitest project
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/worker/**']
				}
			}
		]
	}
});
