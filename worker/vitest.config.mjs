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
			// The webhook secret is a real secret in production (wrangler secret
			// put TELEGRAM_WEBHOOK_SECRET) and therefore absent from
			// wrangler.jsonc. The fetch handler fails closed without it, so the
			// tests need a known value to send in the header.
			miniflare: {
				bindings: { TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret" },
			},
		}),
	],
});
