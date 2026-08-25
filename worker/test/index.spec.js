import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("invoice bot worker", () => {
	it("GET responds with a health check message", async () => {
		const request = new Request("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toBe("Invoice bot is running");
	});

	it("POST with an update type we don't handle (no chat id) is acknowledged without dispatching to a Durable Object", async () => {
		const update = { update_id: 2, my_chat_member: { chat: { id: 1 } } };
		const request = new Request("http://example.com", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(update),
		});
		const response = await SELF.fetch(request);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
	});

	it("POST with a malformed body still returns 400, not a crash", async () => {
		const request = new Request("http://example.com", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		const response = await SELF.fetch(request);
		expect(response.status).toBe(400);
	});
});
