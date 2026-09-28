import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.test.jsonc' },
			miniflare: { kvNamespaces: ['HOST_TOKENS'] }
		})
	],
	test: {
		include: ['src/worker/**/*.spec.ts']
	}
});
