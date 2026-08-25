import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// test-visual/ holds Playwright layout regression tests (run separately via
	// `npm run test:layout`) — they render real HTML in a browser to measure
	// computed geometry, which workerd (this pool) has no layout engine for.
	test: {
		include: ["test/**/*.spec.js"],
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
