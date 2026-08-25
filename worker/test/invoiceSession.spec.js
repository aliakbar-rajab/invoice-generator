import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderInvoicePdf } from "../src/lib/pdf.js";

// PDF generation goes through Cloudflare Browser Rendering, which isn't
// available in this local test run (and would be far too slow for a unit
// test anyway). These tests care about the bot's state machine and message
// flow, not the render step itself, so replace it with an instant failure —
// this also happens to exercise the "generation failed" error-message path.
// Individual tests can override this once via mockImplementationOnce to
// exercise the success path instead.
vi.mock("../src/lib/pdf.js", () => ({
	renderInvoicePdf: vi.fn(async () => {
		throw new Error("mocked: no browser rendering available in tests");
	}),
}));

let nextChatId = 900000;
function freshChatId() {
	nextChatId += 1;
	return nextChatId;
}

function textUpdate(chatId, text, updateId) {
	return {
		update_id: updateId,
		message: { message_id: updateId, chat: { id: chatId }, date: 0, text },
	};
}

function callbackUpdate(chatId, data, updateId, messageId = 1) {
	return {
		update_id: updateId,
		callback_query: {
			id: `cb${updateId}`,
			data,
			message: { message_id: messageId, chat: { id: chatId }, date: 0 },
		},
	};
}

function stubFor(chatId) {
	return env.INVOICE_SESSION.getByName(String(chatId));
}

async function send(chatId, update) {
	const stub = stubFor(chatId);
	return runInDurableObject(stub, (instance) => instance.handleUpdate(update));
}

async function readState(chatId) {
	const stub = stubFor(chatId);
	return runInDurableObject(stub, (instance, state) => state.storage.get("state"));
}

function installFetchMock() {
	const calls = [];
	let nextMessageId = 1;
	const fn = vi.fn(async (url, init) => {
		const method = String(url).split("/").pop();
		let body = {};
		if (typeof init?.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = {};
			}
		} else if (init?.body && typeof init.body.entries === "function") {
			body = Object.fromEntries(init.body.entries());
		}
		const entry = { method, body };
		calls.push(entry);
		if (method === "sendMessage") {
			const messageId = nextMessageId++;
			entry.resultMessageId = messageId;
			return new Response(
				JSON.stringify({ ok: true, result: { message_id: messageId, chat: { id: body.chat_id }, text: body.text } }),
				{ status: 200 }
			);
		}
		return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
	});
	vi.stubGlobal("fetch", fn);
	return calls;
}

function lastMessage(calls) {
	const sent = calls.filter((c) => c.method === "sendMessage");
	return sent[sent.length - 1];
}

function messagesContaining(calls, substring) {
	return calls.filter((c) => c.method === "sendMessage" && c.body.text?.includes(substring));
}

describe("InvoiceSession flow", () => {
	let calls;
	let updateId;

	beforeEach(() => {
		calls = installFetchMock();
		updateId = 1;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function nextUpdateId() {
		updateId += 1;
		return updateId;
	}

	it("offers a third 'enter company name' option alongside the two existing companies", async () => {
		const chatId = freshChatId();
		await send(chatId, textUpdate(chatId, "/start", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "➕ فاکتور جدید", nextUpdateId()));

		const msg = lastMessage(calls);
		const rows = msg.body.reply_markup.inline_keyboard;
		const labels = rows.map((row) => row.map((btn) => btn.text));

		expect(labels).toContainEqual(["بنیان فولاد داریا"]);
		expect(labels).toContainEqual(["کارا برج پارسه"]);
		expect(labels.some((row) => row.some((t) => t.includes("ورود نام شرکت")))).toBe(true);
	});

	it("lets the user type a custom company name and never shows the internal type to them", async () => {
		const chatId = freshChatId();
		await send(chatId, textUpdate(chatId, "/start", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "➕ فاکتور جدید", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "company:other", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "شرکت آزمایشی من", nextUpdateId()));

		const state = await readState(chatId);
		expect(state.companyKey).toBe("other");
		expect(state.customCompanyName).toBe("شرکت آزمایشی من");
		expect(state.step).toBe("customer_name");

		// The literal internal company-type label must never reach the user.
		for (const call of calls) {
			if (call.method === "sendMessage") {
				expect(call.body.text).not.toContain("سایر");
			}
		}
	});

	it("keeps the normal company selection flow working unchanged", async () => {
		const chatId = freshChatId();
		await send(chatId, textUpdate(chatId, "/start", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "➕ فاکتور جدید", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "company:fouladBonyan", nextUpdateId()));

		const state = await readState(chatId);
		expect(state.companyKey).toBe("fouladBonyan");
		expect(state.step).toBe("customer_name");
	});

	async function reachCustomerAction(chatId) {
		await send(chatId, textUpdate(chatId, "/start", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "➕ فاکتور جدید", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "company:fouladBonyan", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "مشتری تست", nextUpdateId()));
	}

	it("shows item-entry vs customer-detail choice after the customer name, and 'ورود اقلام کالا' skips straight to items", async () => {
		const chatId = freshChatId();
		await reachCustomerAction(chatId);

		let state = await readState(chatId);
		expect(state.step).toBe("customer_action");
		const choiceMsg = lastMessage(calls);
		const labels = choiceMsg.body.reply_markup.inline_keyboard.flat().map((b) => b.text);
		expect(labels.some((t) => t.includes("ورود اقلام کالا"))).toBe(true);
		expect(labels.some((t) => t.includes("تکمیل اطلاعات مشتری"))).toBe(true);

		await send(chatId, callbackUpdate(chatId, "custentry:items", nextUpdateId()));
		state = await readState(chatId);
		expect(state.step).toBe("item_description");
		expect(lastMessage(calls).body.text).toContain("شرح کالا");
	});

	it("walks the customer-detail fields, honoring skip and mid-flow jump to items, leaving skipped fields empty", async () => {
		const chatId = freshChatId();
		await reachCustomerAction(chatId);

		await send(chatId, callbackUpdate(chatId, "custentry:details", nextUpdateId()));
		let state = await readState(chatId);
		expect(state.step).toBe("customer_detail_address");

		await send(chatId, textUpdate(chatId, "تهران، خیابان آزادی", nextUpdateId()));
		state = await readState(chatId);
		expect(state.buyerAddress).toBe("تهران، خیابان آزادی");
		expect(state.step).toBe("customer_detail_postal");

		await send(chatId, callbackUpdate(chatId, "custdetail:skip", nextUpdateId()));
		state = await readState(chatId);
		expect(state.buyerPostalCode).toBeNull();
		expect(state.step).toBe("customer_detail_national");

		await send(chatId, callbackUpdate(chatId, "custdetail:items", nextUpdateId()));
		state = await readState(chatId);
		expect(state.step).toBe("item_description");
		expect(state.buyerNationalId).toBeNull();
		expect(state.buyerPhone).toBeNull();
		expect(lastMessage(calls).body.text).toContain("شرح کالا");
	});

	it("deletes the waiting message once the invoice is generated and sent successfully", async () => {
		renderInvoicePdf.mockImplementationOnce(async () => new Uint8Array([1, 2, 3]));

		const chatId = freshChatId();
		await reachCustomerAction(chatId);
		await send(chatId, callbackUpdate(chatId, "custentry:items", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "کالای تست", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "۲", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "۱۰۰۰۰", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "additem:no", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "stamp:no", nextUpdateId()));

		const waitMessages = messagesContaining(calls, "در حال آماده‌سازی و ارسال پیش‌فاکتور");
		expect(waitMessages.length).toBe(1);

		const deleteCalls = calls.filter((c) => c.method === "deleteMessage");
		expect(deleteCalls.length).toBe(1);
		expect(deleteCalls[0].body.message_id).toBe(waitMessages[0].resultMessageId);

		const sendDocumentCalls = calls.filter((c) => c.method === "sendDocument");
		expect(sendDocumentCalls.length).toBe(1);

		const state = await readState(chatId);
		expect(state.step).toBe("idle");
	});

	it("sends a waiting message before generation starts and edits it to an error on failure", async () => {
		const chatId = freshChatId();
		await reachCustomerAction(chatId);
		await send(chatId, callbackUpdate(chatId, "custentry:items", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "کالای تست", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "۲", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "۱۰۰۰۰", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "additem:no", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "stamp:no", nextUpdateId()));

		const waitMessages = messagesContaining(calls, "در حال آماده‌سازی و ارسال پیش‌فاکتور");
		expect(waitMessages.length).toBe(1);

		const editCalls = calls.filter((c) => c.method === "editMessageText");
		expect(editCalls.length).toBe(1);
		expect(editCalls[0].body.text).toContain("مشکلی پیش آمد");
		expect(editCalls[0].body.message_id).toBe(waitMessages[0].resultMessageId);

		const state = await readState(chatId);
		expect(state.step).toBe("ask_stamp");
	});

	it("prevents duplicate invoice generation from a rapid double-tap on the stamp button", async () => {
		const chatId = freshChatId();
		await reachCustomerAction(chatId);
		await send(chatId, callbackUpdate(chatId, "custentry:items", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "کالای تست", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "۲", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "۱۰۰۰۰", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "additem:no", nextUpdateId()));

		let state = await readState(chatId);
		expect(state.step).toBe("ask_stamp");

		const stub = stubFor(chatId);
		const id1 = nextUpdateId();
		const id2 = nextUpdateId();
		await Promise.all([
			runInDurableObject(stub, (instance) => instance.handleUpdate(callbackUpdate(chatId, "stamp:no", id1))),
			runInDurableObject(stub, (instance) => instance.handleUpdate(callbackUpdate(chatId, "stamp:no", id2))),
		]);

		const waitMessages = messagesContaining(calls, "در حال آماده‌سازی و ارسال پیش‌فاکتور");
		expect(waitMessages.length).toBe(1);
	});
});
