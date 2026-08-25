/*
 * Minimal Telegram Bot API client. Every call takes the bot token as an
 * explicit argument (never logged, never embedded in source) and talks
 * straight to api.telegram.org.
 */

const API_ROOT = "https://api.telegram.org";

async function call(token, method, payload) {
  const res = await fetch(`${API_ROOT}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    // Telegram's error description never contains the token, so this is
    // safe to surface in logs/exceptions.
    throw new Error(`Telegram API ${method} failed: ${data.description || res.status}`);
  }
  return data.result;
}

export function sendMessage(token, chatId, text, options = {}) {
  return call(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...options,
  });
}

export function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return call(token, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
}

export function editMessageText(token, chatId, messageId, text, options = {}) {
  return call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...options,
  });
}

export function deleteMessage(token, chatId, messageId) {
  return call(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

export function answerCallbackQuery(token, callbackQueryId, options = {}) {
  return call(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...options,
  });
}

export function sendChatAction(token, chatId, action) {
  return call(token, "sendChatAction", { chat_id: chatId, action });
}

export async function sendDocument(token, chatId, bytes, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([bytes], { type: "application/pdf" }), filename);

  const res = await fetch(`${API_ROOT}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API sendDocument failed: ${data.description || res.status}`);
  }
  return data.result;
}

export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

export function replyKeyboard(rows) {
  return { keyboard: rows, resize_keyboard: true };
}
