/*
 * Regressions for defects that existed only in the bot half of the product —
 * each one was already found and fixed in the desktop app, or is a hazard the
 * app never had. They live in their own file so the flow spec above stays a
 * readable description of the happy path.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderInvoicePdf } from "../src/lib/pdf.js";

vi.mock("../src/lib/pdf.js", () => ({
	renderInvoicePdf: vi.fn(async () => {
		throw new Error("mocked: no browser rendering available in tests");
	}),
}));

let nextChatId = 700000;
function freshChatId() {
	nextChatId += 1;
	return nextChatId;
}

function textUpdate(chatId, text, updateId) {
	return { update_id: updateId, message: { message_id: updateId, chat: { id: chatId }, date: 0, text } };
}

function callbackUpdate(chatId, data, updateId, messageId = 1) {
	return {
		update_id: updateId,
		callback_query: { id: `cb${updateId}`, data, message: { message_id: messageId, chat: { id: chatId }, date: 0 } },
	};
}

function stubFor(chatId) {
	return env.INVOICE_SESSION.getByName(String(chatId));
}

async function send(chatId, update) {
	return runInDurableObject(stubFor(chatId), (instance) => instance.handleUpdate(update));
}

async function readState(chatId) {
	return runInDurableObject(stubFor(chatId), (instance, state) => state.storage.get("state"));
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

function sentMessages(calls) {
	return calls.filter((c) => c.method === "sendMessage");
}

function lastMessage(calls) {
	const sent = sentMessages(calls);
	return sent[sent.length - 1];
}

describe("bot-only regressions", () => {
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

	async function reachItemEntry(chatId) {
		await send(chatId, textUpdate(chatId, "/start", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "➕ فاکتور جدید", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "company:fouladBonyan", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "مشتری تست", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "custentry:items", nextUpdateId()));
	}

	// ---------- Numeric parsing ----------
	//
	// The app fixed this in normalizeStrictNumber (js/app.js); the bot kept
	// stripping separators unconditionally, so a comma — which is what many
	// keyboards produce for a decimal point — silently multiplied the value
	// by ten and printed it onto a real invoice.

	it("refuses a comma-decimal quantity instead of silently reading it as ten times more", async () => {
		const chatId = freshChatId();
		await reachItemEntry(chatId);
		await send(chatId, textUpdate(chatId, "میلگرد آجدار", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "۲,۵", nextUpdateId()));

		const state = await readState(chatId);
		expect(state.step, "must stay on the quantity question, not accept ۲۵").toBe("item_quantity");
		expect(lastMessage(calls).body.text).toContain("معتبر نیست");
		// The one mistake this field actually sees deserves naming.
		expect(lastMessage(calls).body.text).toContain("ویرگول");
	});

	it("still accepts the decimal and grouped forms the bot itself prints", async () => {
		for (const [quantity, price, expectedQtyMilli, expectedRial] of [
			["2.5", "1500000", "2500", "1500000"],
			["۲٫۵", "۱٬۵۰۰٬۰۰۰", "2500", "1500000"],
			["10", "1,500,000", "10000", "1500000"],
		]) {
			const chatId = freshChatId();
			await reachItemEntry(chatId);
			await send(chatId, textUpdate(chatId, "کالای تست", nextUpdateId()));
			await send(chatId, textUpdate(chatId, quantity, nextUpdateId()));
			await send(chatId, textUpdate(chatId, price, nextUpdateId()));

			const state = await readState(chatId);
			expect(state.step, `${quantity} × ${price} must be accepted`).toBe("item_more");
			expect(state.items[0].quantityMilli).toBe(expectedQtyMilli);
			expect(state.items[0].unitPriceRial).toBe(expectedRial);
		}
	});

	it("refuses junk that used to be silently salvaged into a number", async () => {
		for (const quantity of ["10 kg", "12abc", "2/5", "1,000 000", "1.0005"]) {
			const chatId = freshChatId();
			await reachItemEntry(chatId);
			await send(chatId, textUpdate(chatId, "کالای تست", nextUpdateId()));
			await send(chatId, textUpdate(chatId, quantity, nextUpdateId()));
			const state = await readState(chatId);
			expect(state.step, `"${quantity}" must not be accepted as a quantity`).toBe("item_quantity");
		}
	});

	it("refuses a Rial amount carrying a decimal point, since Rial has no subunit", async () => {
		const chatId = freshChatId();
		await reachItemEntry(chatId);
		await send(chatId, textUpdate(chatId, "کالای تست", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "1", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "1500000.5", nextUpdateId()));

		const state = await readState(chatId);
		expect(state.step).toBe("item_price");
	});

	// ---------- HTML escaping ----------
	//
	// Every message goes out with parse_mode "HTML". A "<" in user text used
	// to reach Telegram as markup, which rejected the whole message, threw
	// mid-flow, and left the conversation without the keyboard it was about
	// to send.

	it("escapes an item description containing angle brackets and still sends the next prompt", async () => {
		const chatId = freshChatId();
		await reachItemEntry(chatId);
		await send(chatId, textUpdate(chatId, "لوله <2 اینچ> & مهره", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "2", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "1500000", nextUpdateId()));

		const summary = sentMessages(calls).find((c) => c.body.text?.includes("ثبت شد:"));
		expect(summary, "the row-added summary must still be sent").toBeTruthy();
		expect(summary.body.text).toContain("&lt;2 اینچ&gt;");
		expect(summary.body.text).not.toContain("<2 اینچ>");
		expect(summary.body.text).toContain("&amp;");

		// The whole point of escaping: the flow does NOT dead-end. The user is
		// asked whether to add another item, with a working keyboard.
		const last = lastMessage(calls);
		expect(last.body.text).toContain("آیتم دیگری");
		expect(last.body.reply_markup.inline_keyboard.length).toBeGreaterThan(0);

		// The description reaches the invoice unescaped — the template does its
		// own escaping, so double-escaping here would print "&lt;" on the sheet.
		const state = await readState(chatId);
		expect(state.items[0].description).toBe("لوله <2 اینچ> & مهره");
	});

	// ---------- Invoice numbering across a failed render ----------

	it("does not retire an accounting number when the PDF render fails", async () => {
		const counter = env.INVOICE_COUNTER.getByName("global");
		const year = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
			timeZone: "Asia/Tehran",
			year: "numeric",
		})
			.format(new Date())
			.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

		// Whatever earlier tests in this file left behind, plus one: the number
		// the first attempt below should draw.
		const before = await counter.next("fouladBonyan", year);
		await counter.release("fouladBonyan", year, before);

		async function attempt() {
			const chatId = freshChatId();
			await reachItemEntry(chatId);
			await send(chatId, textUpdate(chatId, "کالای تست", nextUpdateId()));
			await send(chatId, textUpdate(chatId, "2", nextUpdateId()));
			await send(chatId, textUpdate(chatId, "1500000", nextUpdateId()));
			await send(chatId, callbackUpdate(chatId, "additem:no", nextUpdateId()));
			await send(chatId, callbackUpdate(chatId, "stamp:no", nextUpdateId()));
		}

		// Three failed renders in a row (renderInvoicePdf is mocked to throw).
		await attempt();
		await attempt();
		await attempt();

		// Every one of them handed its number back, so the next real invoice
		// still gets the first one. Before the fix this was `before + 3`.
		expect(await counter.next("fouladBonyan", year)).toBe(before);
	});

	it("keeps the number once an invoice has actually been sent", async () => {
		const counter = env.INVOICE_COUNTER.getByName("global");
		const year = "1499"; // a year no other test touches
		const baseline = await counter.next("karaBorjParseh", year);

		renderInvoicePdf.mockImplementationOnce(async () => new Uint8Array([1, 2, 3]));

		const chatId = freshChatId();
		await send(chatId, textUpdate(chatId, "/start", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "➕ فاکتور جدید", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "company:karaBorjParseh", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "مشتری تست", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "custentry:items", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "کالای تست", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "2", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "1500000", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "additem:no", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "stamp:no", nextUpdateId()));

		expect(calls.some((c) => c.method === "sendDocument"), "the PDF must have been sent").toBe(true);
		// The counter for THIS year advanced and stayed advanced — release only
		// ever fires on the failure path.
		expect(baseline).toBe(1);
		const state = await readState(chatId);
		expect(state.step, "a sent invoice resets the session").toBe("idle");
	});

	it("escapes a custom company name containing angle brackets and still asks for the customer", async () => {
		const chatId = freshChatId();
		await send(chatId, textUpdate(chatId, "/start", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "➕ فاکتور جدید", nextUpdateId()));
		await send(chatId, callbackUpdate(chatId, "company:other", nextUpdateId()));
		await send(chatId, textUpdate(chatId, "شرکت <آزمایشی>", nextUpdateId()));

		const confirmation = sentMessages(calls).find((c) => c.body.text?.includes("نام شرکت ثبت شد"));
		expect(confirmation.body.text).toContain("&lt;آزمایشی&gt;");

		expect(lastMessage(calls).body.text).toContain("نام مشتری");
		const state = await readState(chatId);
		expect(state.customCompanyName).toBe("شرکت <آزمایشی>");
		expect(state.step).toBe("customer_name");
	});
});

// ---------- Invoice numbering ----------

describe("InvoiceCounter", () => {
	function counter() {
		return env.INVOICE_COUNTER.getByName("global");
	}

	it("hands out sequential numbers per company and year", async () => {
		const stub = counter();
		expect(await stub.next("acme", "1405")).toBe(1);
		expect(await stub.next("acme", "1405")).toBe(2);
		// A different company, and a different year, each start again at 1.
		expect(await stub.next("other", "1405")).toBe(1);
		expect(await stub.next("acme", "1406")).toBe(1);
	});

	it("gives a number back when the invoice it was drawn for was never issued", async () => {
		const stub = counter();
		const first = await stub.next("release-a", "1405");
		expect(await stub.release("release-a", "1405", first)).toBe(true);
		// The very next invoice reuses it: no gap in the sequence.
		expect(await stub.next("release-a", "1405")).toBe(first);
	});

	it("refuses to rewind past a number another invoice has already built on", async () => {
		const stub = counter();
		const mine = await stub.next("release-b", "1405");
		const theirs = await stub.next("release-b", "1405");
		expect(theirs).toBe(mine + 1);

		// Their invoice is out in the world carrying `theirs`. Rewinding to
		// reclaim `mine` would hand `theirs` out a second time, which is far
		// worse than the gap it would close.
		expect(await stub.release("release-b", "1405", mine)).toBe(false);
		expect(await stub.next("release-b", "1405")).toBe(theirs + 1);
	});
});
