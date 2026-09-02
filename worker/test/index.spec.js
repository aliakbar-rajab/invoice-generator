import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

// Matches the binding in vitest.config.mjs.
const SECRET = "test-webhook-secret";

function webhookRequest(body, { secret = SECRET } = {}) {
	const headers = { "Content-Type": "application/json" };
	if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
	return new Request("http://example.com", {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

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
		const response = await SELF.fetch(webhookRequest(update));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
	});

	it("POST with a malformed body still returns 400, not a crash", async () => {
		const response = await SELF.fetch(webhookRequest("not json"));
		expect(response.status).toBe(400);
	});
});

describe("webhook authentication", () => {
	const update = { update_id: 3, message: { message_id: 1, chat: { id: 5551 }, date: 0, text: "/start" } };

	it("refuses a POST carrying no secret header at all", async () => {
		const response = await SELF.fetch(webhookRequest(update, { secret: null }));
		expect(response.status).toBe(403);
	});

	it("refuses a POST carrying the wrong secret", async () => {
		const response = await SELF.fetch(webhookRequest(update, { secret: "not-the-secret" }));
		expect(response.status).toBe(403);
	});

	// Same length as the real secret, so this can only pass by comparing the
	// bytes rather than by the early length bail.
	it("refuses a same-length near-miss secret", async () => {
		const near = SECRET.slice(0, -1) + (SECRET.slice(-1) === "x" ? "y" : "x");
		expect(near).toHaveLength(SECRET.length);
		const response = await SELF.fetch(webhookRequest(update, { secret: near }));
		expect(response.status).toBe(403);
	});

	it("rejects before parsing the body, so an unauthenticated request cannot reach the update router", async () => {
		// A body that would 400 if it were ever parsed: the 403 proves the
		// secret check runs first.
		const response = await SELF.fetch(webhookRequest("not json", { secret: null }));
		expect(response.status).toBe(403);
	});

	it("fails closed when no secret is configured, rather than accepting everything", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			webhookRequest(update, { secret: null }),
			{ ...env, TELEGRAM_WEBHOOK_SECRET: undefined },
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
	});

	it("still answers the GET health check without a secret", async () => {
		const response = await SELF.fetch(new Request("http://example.com"));
		expect(response.status).toBe(200);
	});

	it("accepts a POST carrying the right secret", async () => {
		const response = await SELF.fetch(webhookRequest({ update_id: 9, my_chat_member: { chat: { id: 1 } } }));
		expect(response.status).toBe(200);
	});
});
