export { InvoiceSession } from "./durableObjects/InvoiceSession.js";
export { InvoiceCounter } from "./durableObjects/InvoiceCounter.js";

/*
 * Telegram signs every webhook delivery with the secret given to setWebhook,
 * sent back as this header. Checking it is the only thing standing between
 * this endpoint and the open internet: `chat_id` is read straight out of the
 * request body and used as the Durable Object name, so without the check
 * anyone who learns the Worker URL can drive any chat's session, issue
 * invoices under either real company, consume accounting numbers, and spend
 * Browser Rendering quota.
 *
 * Set it with:
 *     npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
 * and register the same value with Telegram:
 *     https://api.telegram.org/bot<TOKEN>/setWebhook
 *         ?url=<worker-url>&secret_token=<the-same-secret>
 */
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

// Constant-time-ish compare: bail on length first, then OR every byte
// difference together so the loop's duration doesn't depend on where the
// first mismatch is.
function secretMatches(expected, received) {
  if (typeof expected !== "string" || typeof received !== "string") return false;
  if (expected.length === 0 || expected.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Invoice bot is running");
    }

    // Fails closed. An unconfigured secret is a deployment that is not yet
    // safe to expose, not a reason to accept everything — the health check
    // above still answers, so a misconfiguration is visible rather than
    // silent.
    if (!secretMatches(env.TELEGRAM_WEBHOOK_SECRET, request.headers.get(SECRET_HEADER))) {
      if (!env.TELEGRAM_WEBHOOK_SECRET) {
        console.error(
          "TELEGRAM_WEBHOOK_SECRET is not set; webhook updates are being refused. " +
            "Set it with `wrangler secret put TELEGRAM_WEBHOOK_SECRET` and pass the " +
            "same value as secret_token to Telegram's setWebhook."
        );
      }
      return new Response("Forbidden", { status: 403 });
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
