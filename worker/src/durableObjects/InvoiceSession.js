import { DurableObject } from "cloudflare:workers";
import {
  sendMessage,
  editMessageReplyMarkup,
  editMessageText,
  deleteMessage,
  answerCallbackQuery,
  sendChatAction,
  sendDocument,
  inlineKeyboard,
  replyKeyboard,
  escapeHtml,
} from "../lib/telegram.js";
import { COMPANIES, COMPANY_ORDER, getCompany, OTHER_COMPANY_KEY, buildCustomCompany } from "../lib/companies.js";
import {
  parseQtyMilli,
  parseMoneyBig,
  toPersianDigits,
  toAsciiDigits,
  formatQtyMilli,
  formatBigRial,
} from "../lib/persianNumbers.js";
import { buildInvoiceHtml } from "../lib/invoiceTemplate.js";
import { renderInvoicePdf } from "../lib/pdf.js";
import { loadDataUri } from "../lib/assets.js";

const MAIN_MENU = replyKeyboard([["➕ فاکتور جدید"]]);
const MAX_HISTORY = 100;
const MAX_ITEMS = 30;

const WAIT_MESSAGE_TEXT = "⏳ در حال آماده‌سازی و ارسال پیش‌فاکتور، لطفاً منتظر بمانید…";

// The seller's local zone. Every date the bot stamps on a sheet — and the
// year its invoice counter is keyed by — is a date in this zone, never the
// Worker's own UTC. See generateAndSendInvoice.
const INVOICE_TIME_ZONE = "Asia/Tehran";

// Sequential customer-detail fields asked after "تکمیل اطلاعات مشتری". Each
// step can be skipped or short-circuited straight to item entry.
const CUSTOMER_DETAIL_FIELDS = [
  { step: "customer_detail_address", stateKey: "buyerAddress", prompt: "🏠 نشانی مشتری را وارد کنید:" },
  { step: "customer_detail_postal", stateKey: "buyerPostalCode", prompt: "📮 کد پستی مشتری را وارد کنید:" },
  { step: "customer_detail_national", stateKey: "buyerNationalId", prompt: "🆔 شناسه ملی مشتری را وارد کنید:" },
  { step: "customer_detail_phone", stateKey: "buyerPhone", prompt: "☎️ تلفن مشتری را وارد کنید:" },
];

function isCustomerDetailStep(step) {
  return CUSTOMER_DETAIL_FIELDS.some((f) => f.step === step);
}

function customerDetailField(step) {
  return CUSTOMER_DETAIL_FIELDS.find((f) => f.step === step);
}

// Step to move to once a customer-detail field is filled/skipped: the next
// field, or item entry after the last one.
function afterCustomerDetailStep(step) {
  const idx = CUSTOMER_DETAIL_FIELDS.findIndex((f) => f.step === step);
  return CUSTOMER_DETAIL_FIELDS[idx + 1]?.step ?? "item_description";
}

function freshState() {
  return {
    step: "idle",
    companyKey: null,
    customCompanyName: null,
    buyerName: null,
    buyerAddress: null,
    buyerPostalCode: null,
    buyerNationalId: null,
    buyerPhone: null,
    items: [],
    currentItem: {},
    taxPercent: 10,
    includeStamp: null,
    history: [],
  };
}

function snapshotWithoutHistory(state) {
  const { history, ...rest } = state;
  return structuredClone(rest);
}

function backAndCancelKeyboard(extraRows = []) {
  return inlineKeyboard([
    ...extraRows,
    [
      { text: "🔙 بازگشت", callback_data: "back" },
      { text: "❌ لغو", callback_data: "cancel" },
    ],
  ]);
}

function customerDetailKeyboard() {
  return backAndCancelKeyboard([
    [{ text: "⏭ رد کردن این مورد", callback_data: "custdetail:skip" }],
    [{ text: "📦 ورود اقلام کالا", callback_data: "custdetail:items" }],
  ]);
}

export class InvoiceSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    // In-memory guard against double-triggering PDF generation from a
    // rapid double-tap on the final "stamp" button. Deliberately not part
    // of persisted state: it only needs to survive within one live
    // instance, checked/set synchronously (no await in between) so two
    // near-simultaneous callback deliveries can't both pass the check.
    this.generating = false;
  }

  async loadState() {
    if (!this.state) {
      this.state = (await this.ctx.storage.get("state")) || freshState();
    }
    return this.state;
  }

  async saveState(state) {
    this.state = state;
    await this.ctx.storage.put("state", state);
  }

  // Pushes the current state onto the undo stack, then hands the caller a
  // deep clone to mutate freely into the next state.
  advance(state, mutate) {
    const snapshot = snapshotWithoutHistory(state);
    const history = [...state.history, snapshot].slice(-MAX_HISTORY);
    const next = mutate(structuredClone(snapshot));
    next.history = history;
    return next;
  }

  goBack(state) {
    if (state.history.length === 0) return state;
    const previous = state.history[state.history.length - 1];
    return { ...structuredClone(previous), history: state.history.slice(0, -1) };
  }

  async handleUpdate(update) {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    try {
      if (update.callback_query) {
        await this.handleCallback(update.callback_query, token);
      } else if (update.message) {
        await this.handleMessage(update.message, token);
      }
    } catch (err) {
      console.error("InvoiceSession.handleUpdate failed:", err);
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (chatId) {
        await sendMessage(token, chatId, "⚠️ خطایی رخ داد. لطفاً دوباره تلاش کنید یا «❌ لغو» را بزنید.").catch(() => {});
      }
    }
  }

  // ---------------- Messages (free text + commands) ----------------

  async handleMessage(message, token) {
    const chatId = message.chat.id;
    const text = (message.text || "").trim();
    let state = await this.loadState();

    if (text === "/start") {
      state = freshState();
      await this.saveState(state);
      await sendMessage(
        token,
        chatId,
        "سلام 👋\nربات صدور پیش‌فاکتور آماده است.\nبرای شروع، «➕ فاکتور جدید» را بزنید.",
        { reply_markup: MAIN_MENU }
      );
      return;
    }

    if (text === "/cancel" || text === "❌ لغو") {
      await this.saveState(freshState());
      await sendMessage(token, chatId, "عملیات لغو شد.", { reply_markup: MAIN_MENU });
      return;
    }

    if (text === "/new" || text === "➕ فاکتور جدید") {
      state = this.advance(freshState(), (s) => {
        s.step = "choose_company";
        return s;
      });
      await this.saveState(state);
      await this.promptChooseCompany(chatId, token);
      return;
    }

    if (text.startsWith("/tax") || text.startsWith("/maliat")) {
      const parts = text.split(/\s+/);
      if (parts.length > 1) {
        const rateStr = toAsciiDigits(parts[1]).trim().replace(/٫/g, ".");
        const num = parseFloat(rateStr);
        if (!Number.isNaN(num) && Number.isFinite(num) && num >= 0 && num <= 100) {
          state = this.advance(state, (s) => {
            s.taxPercent = num;
            return s;
          });
          await this.saveState(state);
          await sendMessage(
            token,
            chatId,
            `✅ درصد مالیات روی ٪${toPersianDigits(rateStr).replace(/\./g, "٫")} تنظیم شد.`
          );
          return;
        } else {
          await sendMessage(
            token,
            chatId,
            "❗️درصد مالیات باید عددی بین ۰ تا ۱۰۰ باشد (مثال: /tax 10 یا /tax 0 یا /tax 9.5)."
          );
          return;
        }
      } else {
        await sendMessage(
          token,
          chatId,
          `درصد مالیات جاری: ٪${toPersianDigits(String(state.taxPercent ?? 10)).replace(/\./g, "٫")}\nبرای تغییر، ارسال کنید: /tax 0 یا /tax 10`
        );
        return;
      }
    }

    if (isCustomerDetailStep(state.step)) {
      await this.onCustomerDetailField(chatId, token, state, text);
      return;
    }

    switch (state.step) {
      case "custom_company_name":
        await this.onCustomCompanyName(chatId, token, state, text);
        return;
      case "customer_name":
        await this.onCustomerName(chatId, token, state, text);
        return;
      case "customer_action":
        await this.promptCustomerAction(chatId, token);
        return;
      case "item_description":
        await this.onItemDescription(chatId, token, state, text);
        return;
      case "item_quantity":
        await this.onItemQuantity(chatId, token, state, text);
        return;
      case "item_price":
        await this.onItemPrice(chatId, token, state, text);
        return;
      default:
        await sendMessage(
          token,
          chatId,
          "برای شروع صدور پیش‌فاکتور، «➕ فاکتور جدید» را بزنید.",
          { reply_markup: MAIN_MENU }
        );
        return;
    }
  }

  async onCustomerName(chatId, token, state, text) {
    if (!text) {
      await sendMessage(token, chatId, "❗️نام مشتری نمی‌تواند خالی باشد. دوباره وارد کنید:", {
        reply_markup: backAndCancelKeyboard(),
      });
      return;
    }
    const next = this.advance(state, (s) => {
      s.buyerName = text.slice(0, 200);
      s.step = "customer_action";
      return s;
    });
    await this.saveState(next);
    await this.promptCustomerAction(chatId, token);
  }

  async onCustomCompanyName(chatId, token, state, text) {
    if (!text) {
      await sendMessage(token, chatId, "❗️نام شرکت نمی‌تواند خالی باشد. دوباره وارد کنید:", {
        reply_markup: backAndCancelKeyboard(),
      });
      return;
    }
    const name = text.slice(0, 200);
    const next = this.advance(state, (s) => {
      s.companyKey = OTHER_COMPANY_KEY;
      s.customCompanyName = name;
      s.step = "customer_name";
      return s;
    });
    await this.saveState(next);
    await sendMessage(token, chatId, `✅ نام شرکت ثبت شد: ${escapeHtml(name)}`);
    await sendMessage(token, chatId, "👤 نام مشتری (خریدار) را وارد کنید:", {
      reply_markup: backAndCancelKeyboard(),
    });
  }

  async onCustomerDetailField(chatId, token, state, text) {
    const field = customerDetailField(state.step);
    if (!text) {
      await sendMessage(
        token,
        chatId,
        "❗️این مورد نمی‌تواند خالی باشد. مقدار را وارد کنید یا از دکمه‌های زیر استفاده کنید:",
        { reply_markup: customerDetailKeyboard() }
      );
      return;
    }
    const next = this.advance(state, (s) => {
      s[field.stateKey] = text.slice(0, 200);
      s.step = afterCustomerDetailStep(field.step);
      return s;
    });
    await this.saveState(next);
    await this.promptCustomerDetailOrItems(chatId, token, next);
  }

  async onItemDescription(chatId, token, state, text) {
    if (!text) {
      await sendMessage(token, chatId, "❗️شرح کالا نمی‌تواند خالی باشد. دوباره وارد کنید:", {
        reply_markup: backAndCancelKeyboard(),
      });
      return;
    }
    const next = this.advance(state, (s) => {
      s.currentItem = { description: text.slice(0, 300) };
      s.step = "item_quantity";
      return s;
    });
    await this.saveState(next);
    await sendMessage(token, chatId, "🔢 تعداد یا مقدار را وارد کنید (مثال: ۱۰ یا ۲.۵):", {
      reply_markup: backAndCancelKeyboard(),
    });
  }

  async onItemQuantity(chatId, token, state, text) {
    const qty = parseQtyMilli(text);
    if (qty === null || qty <= 0n) {
      await sendMessage(
        token,
        chatId,
        // Names the comma explicitly: "۲,۵" used to be accepted and silently
        // read as ۲۵, so the one mistake this field is most likely to see is
        // now the one the message calls out.
        "❗️مقدار واردشده معتبر نیست. یک عدد مثبت با حداکثر سه رقم اعشار وارد کنید و برای اعشار از نقطه استفاده کنید، نه ویرگول (مثال: ۱۰ یا ۲.۵):",
        { reply_markup: backAndCancelKeyboard() }
      );
      return;
    }
    const next = this.advance(state, (s) => {
      s.currentItem.quantityMilli = qty.toString();
      s.step = "item_price";
      return s;
    });
    await this.saveState(next);
    await sendMessage(token, chatId, "💰 مبلغ واحد را به ریال وارد کنید (مثال: ۱۵۰۰۰۰۰):", {
      reply_markup: backAndCancelKeyboard(),
    });
  }

  async onItemPrice(chatId, token, state, text) {
    const price = parseMoneyBig(text);
    if (price === null || price <= 0n) {
      await sendMessage(
        token,
        chatId,
        "❗️مبلغ واردشده معتبر نیست. مبلغ را به ریال و بدون اعشار وارد کنید (مثال: ۱۵۰۰۰۰۰):",
        { reply_markup: backAndCancelKeyboard() }
      );
      return;
    }
    if (state.items.length >= MAX_ITEMS) {
      await sendMessage(token, chatId, `❗️حداکثر ${toPersianDigits(MAX_ITEMS)} قلم کالا در هر فاکتور مجاز است.`);
      const next = this.advance(state, (s) => {
        s.currentItem = {};
        s.step = "ask_stamp";
        return s;
      });
      await this.saveState(next);
      await this.promptStamp(chatId, token);
      return;
    }

    const next = this.advance(state, (s) => {
      s.items.push({
        description: s.currentItem.description,
        quantityMilli: s.currentItem.quantityMilli,
        unit: s.currentItem.unit || "",
        unitPriceRial: price.toString(),
      });
      s.currentItem = {};
      s.step = s.items.length >= MAX_ITEMS ? "ask_stamp" : "item_more";
      return s;
    });
    await this.saveState(next);
    await this.sendItemAddedSummary(chatId, token, next);
    if (next.items.length >= MAX_ITEMS) {
      await sendMessage(token, chatId, `❗️سقف ${toPersianDigits(MAX_ITEMS)} قلم کالا تکمیل شد.`);
      await this.promptStamp(chatId, token);
    } else {
      await this.promptItemMore(chatId, token, next);
    }
  }

  async sendItemAddedSummary(chatId, token, state) {
    const last = state.items[state.items.length - 1];
    const unitLabel = last.unit ? ` ${escapeHtml(last.unit)}` : "";
    await sendMessage(
      token,
      chatId,
      `✅ ردیف ${toPersianDigits(state.items.length)} ثبت شد:\n` +
        `«${escapeHtml(last.description)}» — ${formatQtyMilli(BigInt(last.quantityMilli))}${unitLabel} × ${formatBigRial(BigInt(last.unitPriceRial))} ریال`
    );
  }

  // ---------------- Callback queries (button taps) ----------------

  async handleCallback(cq, token) {
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const data = cq.data || "";
    let state = await this.loadState();

    // Always acknowledge immediately so the tap doesn't show a spinner, and
    // strip the keyboard from the tapped message so it can't be tapped twice.
    await answerCallbackQuery(token, cq.id).catch(() => {});
    await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] }).catch(() => {});

    if (data === "cancel") {
      await this.saveState(freshState());
      await sendMessage(token, chatId, "عملیات لغو شد.", { reply_markup: MAIN_MENU });
      return;
    }

    if (data === "back") {
      state = this.goBack(state);
      await this.saveState(state);
      await this.promptForStep(chatId, token, state);
      return;
    }

    if (data === "company:other" && state.step === "choose_company") {
      state = this.advance(state, (s) => {
        s.step = "custom_company_name";
        return s;
      });
      await this.saveState(state);
      await sendMessage(token, chatId, "🏢 نام شرکت را وارد کنید:", {
        reply_markup: backAndCancelKeyboard(),
      });
      return;
    }

    if (data.startsWith("company:") && state.step === "choose_company") {
      const key = data.slice("company:".length);
      if (!getCompany(key)) return;
      state = this.advance(state, (s) => {
        s.companyKey = key;
        s.step = "customer_name";
        return s;
      });
      await this.saveState(state);
      await sendMessage(token, chatId, `✅ شرکت انتخاب شد: ${getCompany(key).label}`);
      await sendMessage(token, chatId, "👤 نام مشتری (خریدار) را وارد کنید:", {
        reply_markup: backAndCancelKeyboard(),
      });
      return;
    }

    if (data === "custentry:items" && state.step === "customer_action") {
      state = this.advance(state, (s) => {
        s.step = "item_description";
        return s;
      });
      await this.saveState(state);
      await this.promptItemDescription(chatId, token, state);
      return;
    }

    if (data === "custentry:details" && state.step === "customer_action") {
      state = this.advance(state, (s) => {
        s.step = CUSTOMER_DETAIL_FIELDS[0].step;
        return s;
      });
      await this.saveState(state);
      await this.promptCustomerDetail(chatId, token, state.step);
      return;
    }

    if (data === "custdetail:skip" && isCustomerDetailStep(state.step)) {
      state = this.advance(state, (s) => {
        s.step = afterCustomerDetailStep(s.step);
        return s;
      });
      await this.saveState(state);
      await this.promptCustomerDetailOrItems(chatId, token, state);
      return;
    }

    if (data === "custdetail:items" && isCustomerDetailStep(state.step)) {
      state = this.advance(state, (s) => {
        s.step = "item_description";
        return s;
      });
      await this.saveState(state);
      await this.promptItemDescription(chatId, token, state);
      return;
    }

    if (data === "additem:yes" && state.step === "item_more") {
      if (state.items.length >= MAX_ITEMS) {
        await sendMessage(token, chatId, `❗️حداکثر ${toPersianDigits(MAX_ITEMS)} قلم کالا در هر فاکتور مجاز است.`);
        state = this.advance(state, (s) => {
          s.step = "ask_stamp";
          return s;
        });
        await this.saveState(state);
        await this.promptStamp(chatId, token);
        return;
      }
      state = this.advance(state, (s) => {
        s.step = "item_description";
        return s;
      });
      await this.saveState(state);
      await this.promptItemDescription(chatId, token, state);
      return;
    }

    if (data === "additem:no" && state.step === "item_more") {
      if (state.items.length === 0) {
        await sendMessage(token, chatId, "❗️باید حداقل یک قلم کالا ثبت کنید.");
        await this.promptItemMore(chatId, token);
        return;
      }
      state = this.advance(state, (s) => {
        s.step = "ask_stamp";
        return s;
      });
      await this.saveState(state);
      await this.promptStamp(chatId, token);
      return;
    }

    if (data === "stamp:yes" || data === "stamp:no") {
      if (state.step !== "ask_stamp") return;
      // Synchronous check-then-set with no await in between, so a second
      // callback for a rapid double-tap can't slip through before the
      // first one has flipped the flag.
      if (this.generating) return;
      this.generating = true;
      state = this.advance(state, (s) => {
        s.includeStamp = data === "stamp:yes";
        return s;
      });
      await this.saveState(state);
      try {
        await this.generateAndSendInvoice(chatId, token, state);
      } finally {
        this.generating = false;
      }
      return;
    }
  }

  // ---------------- Prompts ----------------

  async promptChooseCompany(chatId, token) {
    await sendMessage(token, chatId, "🏢 شرکت صادرکننده را انتخاب کنید:", {
      reply_markup: inlineKeyboard([
        ...COMPANY_ORDER.map((key) => [{ text: COMPANIES[key].label, callback_data: `company:${key}` }]),
        [{ text: "✏️ ورود نام شرکت", callback_data: "company:other" }],
        [{ text: "❌ لغو", callback_data: "cancel" }],
      ]),
    });
  }

  async promptCustomerAction(chatId, token) {
    await sendMessage(token, chatId, "چه کاری انجام می‌دهید؟", {
      reply_markup: backAndCancelKeyboard([
        [{ text: "📦 ورود اقلام کالا", callback_data: "custentry:items" }],
        [{ text: "📝 تکمیل اطلاعات مشتری", callback_data: "custentry:details" }],
      ]),
    });
  }

  async promptCustomerDetail(chatId, token, step) {
    const field = customerDetailField(step);
    await sendMessage(token, chatId, field.prompt, { reply_markup: customerDetailKeyboard() });
  }

  // After a customer-detail field is filled/skipped: either the next field,
  // or (past the last one) straight into item entry.
  async promptCustomerDetailOrItems(chatId, token, state) {
    if (state.step === "item_description") {
      await this.promptItemDescription(chatId, token, state);
    } else {
      await this.promptCustomerDetail(chatId, token, state.step);
    }
  }

  async promptItemDescription(chatId, token, state) {
    const n = toPersianDigits(state.items.length + 1);
    await sendMessage(token, chatId, `📦 شرح کالا یا خدمت ردیف ${n} را وارد کنید:`, {
      reply_markup: backAndCancelKeyboard(),
    });
  }

  async promptItemMore(chatId, token, state) {
    const currentState = state || (await this.loadState());
    if (currentState && currentState.items && currentState.items.length >= MAX_ITEMS) {
      await sendMessage(token, chatId, `❗️به حداکثر تعداد مجاز (${toPersianDigits(MAX_ITEMS)} قلم کالا) رسیدید.`);
      const next = this.advance(currentState, (s) => {
        s.step = "ask_stamp";
        return s;
      });
      await this.saveState(next);
      await this.promptStamp(chatId, token);
      return;
    }
    await sendMessage(token, chatId, "➕ آیتم دیگری اضافه می‌کنید؟", {
      reply_markup: inlineKeyboard([
        [
          { text: "✅ بله", callback_data: "additem:yes" },
          { text: "🏁 پایان و ادامه", callback_data: "additem:no" },
        ],
        [
          { text: "🔙 بازگشت", callback_data: "back" },
          { text: "❌ لغو", callback_data: "cancel" },
        ],
      ]),
    });
  }

  async promptStamp(chatId, token) {
    await sendMessage(token, chatId, "🖋 مهر شرکت روی فاکتور درج شود؟", {
      reply_markup: inlineKeyboard([
        [
          { text: "✅ بله", callback_data: "stamp:yes" },
          { text: "🚫 خیر", callback_data: "stamp:no" },
        ],
        [
          { text: "🔙 بازگشت", callback_data: "back" },
          { text: "❌ لغو", callback_data: "cancel" },
        ],
      ]),
    });
  }

  // Re-sends whatever prompt matches state.step — used after "back".
  async promptForStep(chatId, token, state) {
    switch (state.step) {
      case "idle":
        await sendMessage(token, chatId, "برای شروع صدور پیش‌فاکتور، «➕ فاکتور جدید» را بزنید.", {
          reply_markup: MAIN_MENU,
        });
        return;
      case "choose_company":
        await this.promptChooseCompany(chatId, token);
        return;
      case "custom_company_name":
        await sendMessage(token, chatId, "🏢 نام شرکت را وارد کنید:", {
          reply_markup: backAndCancelKeyboard(),
        });
        return;
      case "customer_name":
        await sendMessage(token, chatId, "👤 نام مشتری (خریدار) را وارد کنید:", {
          reply_markup: backAndCancelKeyboard(),
        });
        return;
      case "customer_action":
        await this.promptCustomerAction(chatId, token);
        return;
      case "customer_detail_address":
      case "customer_detail_postal":
      case "customer_detail_national":
      case "customer_detail_phone":
        await this.promptCustomerDetail(chatId, token, state.step);
        return;
      case "item_description":
        await this.promptItemDescription(chatId, token, state);
        return;
      case "item_quantity":
        await sendMessage(token, chatId, "🔢 تعداد یا مقدار را وارد کنید (مثال: ۱۰ یا ۲.۵):", {
          reply_markup: backAndCancelKeyboard(),
        });
        return;
      case "item_price":
        await sendMessage(token, chatId, "💰 مبلغ واحد را به ریال وارد کنید (مثال: ۱۵۰۰۰۰۰):", {
          reply_markup: backAndCancelKeyboard(),
        });
        return;
      case "item_more":
        await this.promptItemMore(chatId, token);
        return;
      case "ask_stamp":
        await this.promptStamp(chatId, token);
        return;
    }
  }

  // ---------------- Final PDF generation ----------------

  async generateAndSendInvoice(chatId, token, state) {
    // Sent before any of the slow work below so the user isn't left staring
    // at a silent chat for several seconds wondering if the bot died.
    const waitMessage = await sendMessage(token, chatId, WAIT_MESSAGE_TEXT).catch(() => null);
    const waitMessageId = waitMessage?.message_id ?? null;

    // The accounting number this attempt drew, so a failed render can hand it
    // back instead of retiring it (see the catch below).
    let reserved = null;

    await sendChatAction(token, chatId, "upload_document").catch(() => {});
    try {
      const company =
        state.companyKey === OTHER_COMPANY_KEY
          ? buildCustomCompany(state.customCompanyName)
          : getCompany(state.companyKey);
      const [logoDataUri, stampDataUri, fontDataUri] = await Promise.all([
        company.logo ? loadDataUri(this.env, company.logo) : Promise.resolve(null),
        state.includeStamp && company.stamp ? loadDataUri(this.env, company.stamp) : Promise.resolve(null),
        loadDataUri(this.env, "/fonts/vazirmatn-arabic-variable.woff2"),
      ]);

      const now = new Date();
      // Workers run as UTC, and Iran is UTC+03:30 — without an explicit zone
      // every invoice issued between midnight and 03:30 Tehran carried the
      // PREVIOUS day's date, and once a year at Nowruz was filed under the
      // previous year's counter. The date on the sheet is the seller's local
      // date, so it is asked for as such.
      const jalaliParts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
        timeZone: INVOICE_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const jalaliYear = jalaliParts.find((p) => p.type === "year").value;
      const docDate = jalaliParts.map((p) => p.value).join("");

      const asciiYear = toAsciiDigits(jalaliYear);
      const counterCompanyKey = state.companyKey === OTHER_COMPANY_KEY ? `other:${chatId}` : state.companyKey;
      const counterStub = this.env.INVOICE_COUNTER.getByName("global");
      const seq = await counterStub.next(counterCompanyKey, asciiYear);
      reserved = { companyKey: counterCompanyKey, yearKey: asciiYear, value: seq };
      const docNumber = `${jalaliYear}-${toPersianDigits(String(seq).padStart(3, "0"))}`;

      const items = state.items.map((it) => ({
        description: it.description,
        unit: it.unit || "",
        quantityMilli: BigInt(it.quantityMilli),
        unitPriceRial: BigInt(it.unitPriceRial),
      }));

      const html = buildInvoiceHtml({
        company: { ...company, logoDataUri, stampDataUri },
        fontDataUri,
        docNumber,
        docDate,
        validity: "پایان روز جاری",
        buyerName: state.buyerName,
        buyerAddress: state.buyerAddress,
        buyerPostalCode: state.buyerPostalCode,
        buyerNationalId: state.buyerNationalId,
        buyerPhone: state.buyerPhone,
        items,
        includeStamp: !!state.includeStamp,
        taxPercent: state.taxPercent !== undefined ? state.taxPercent : 10,
      });

      const pdfBytes = await renderInvoicePdf(this.env, html);
      const companySlug = state.companyKey === OTHER_COMPANY_KEY ? "other" : state.companyKey;
      const filename = `invoice-${companySlug}-${asciiYear}-${String(seq).padStart(3, "0")}.pdf`;

      await sendDocument(token, chatId, pdfBytes, filename, "🎉 پیش‌فاکتور شما آماده است.");
      await this.saveState(freshState());
      if (waitMessageId) {
        await deleteMessage(token, chatId, waitMessageId).catch(() => {});
      }
      await sendMessage(token, chatId, "برای صدور فاکتور جدید، «➕ فاکتور جدید» را بزنید.", {
        reply_markup: MAIN_MENU,
      });
    } catch (err) {
      console.error("generateAndSendInvoice failed:", err);
      // The number was drawn before the render, because it has to be printed
      // ON the sheet. A render that never produced a sheet must not retire
      // it: the user is sent straight back to "🖋 مهر" to retry, and every
      // retry used to burn another number, leaving permanent gaps in a
      // sequence that is meant to be gapless. release() is a no-op unless
      // this attempt still holds the highest number, so a number that some
      // other chat has already built on is never clawed back.
      if (reserved) {
        await this.env.INVOICE_COUNTER.getByName("global")
          .release(reserved.companyKey, reserved.yearKey, reserved.value)
          .catch(() => {});
      }
      const retryState = this.advance(state, (s) => {
        s.step = "ask_stamp";
        return s;
      });
      await this.saveState(retryState);
      const errorText = "⚠️ در تولید فایل PDF مشکلی پیش آمد. لطفاً دوباره تلاش کنید.";
      if (waitMessageId) {
        await editMessageText(token, chatId, waitMessageId, errorText).catch(() => {});
      } else {
        await sendMessage(token, chatId, errorText);
      }
      await this.promptStamp(chatId, token);
    }
  }
}
