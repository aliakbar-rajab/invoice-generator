export { InvoiceSession } from "./durableObjects/InvoiceSession.js";
export { InvoiceCounter } from "./durableObjects/InvoiceCounter.js";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Invoice bot is running");
    }

    let update;
    try {
      update = await request.json();
    } catch (err) {
      return new Response("Bad Request", { status: 400 });
    }

    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (!chatId) {
      // Update type we don't handle (e.g. edited_message, my_chat_member) — ack and ignore.
      return new Response("OK");
    }

    const stub = env.INVOICE_SESSION.getByName(String(chatId));
    try {
      await stub.handleUpdate(update);
    } catch (err) {
      // The Durable Object already tries to message the user on failure;
      // this is the last-resort guard so Telegram always gets a 200 and
      // doesn't hammer the webhook with retries.
      console.error("Unhandled error routing update to InvoiceSession:", err);
    }

    return new Response("OK");
  },
};
