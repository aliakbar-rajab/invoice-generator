import { DurableObject } from "cloudflare:workers";
import {
  sendMessage,
  editMessageReplyMarkup,
  answerCallbackQuery,
  sendChatAction,
  sendDocument,
  inlineKeyboard,
  replyKeyboard,
} from "../lib/telegram.js";
import { COMPANIES, COMPANY_ORDER, getCompany } from "../lib/companies.js";
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
const MAX_HISTORY = 20;
const MAX_ITEMS = 30;

function freshState() {
  return {
    step: "idle",
    companyKey: null,
    buyerName: null,
    items: [],
    currentItem: {},
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

export class InvoiceSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
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
    if (state.history.length === 0) return freshState();
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

    switch (state.step) {
      case "customer_name":
        await this.onCustomerName(chatId, token, state, text);
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
      s.step = "item_description";
      return s;
    });
    await this.saveState(next);
    await this.promptItemDescription(chatId, token, next);
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
        "❗️مقدار واردشده معتبر نیست. یک عدد مثبت وارد کنید (مثال: ۱۰ یا ۲.۵):",
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
        "❗️مبلغ واردشده معتبر نیست. یک عدد مثبت وارد کنید (مثال: ۱۵۰۰۰۰۰):",
        { reply_markup: backAndCancelKeyboard() }
      );
      return;
    }
    if (state.items.length >= MAX_ITEMS) {
      await sendMessage(token, chatId, `❗️حداکثر ${toPersianDigits(MAX_ITEMS)} قلم کالا در هر فاکتور مجاز است.`);
      const next = this.advance(state, (s) => {
        s.step = "item_more";
        return s;
      });
      await this.saveState(next);
      await this.promptItemMore(chatId, token);
      return;
    }

    const next = this.advance(state, (s) => {
      s.items.push({
        description: s.currentItem.description,
        quantityMilli: s.currentItem.quantityMilli,
        unitPriceRial: price.toString(),
      });
      s.currentItem = {};
      s.step = "item_more";
      return s;
    });
    await this.saveState(next);
    await this.sendItemAddedSummary(chatId, token, next);
    await this.promptItemMore(chatId, token);
  }

  async sendItemAddedSummary(chatId, token, state) {
    const last = state.items[state.items.length - 1];
    await sendMessage(
      token,
      chatId,
      `✅ ردیف ${toPersianDigits(state.items.length)} ثبت شد:\n` +
        `«${last.description}» — ${formatQtyMilli(BigInt(last.quantityMilli))} × ${formatBigRial(BigInt(last.unitPriceRial))} ریال`
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

    if (data === "additem:yes" && state.step === "item_more") {
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
      state = this.advance(state, (s) => {
        s.includeStamp = data === "stamp:yes";
        return s;
      });
      await this.saveState(state);
      await this.generateAndSendInvoice(chatId, token, state);
      return;
    }
  }

  // ---------------- Prompts ----------------

  async promptChooseCompany(chatId, token) {
    await sendMessage(token, chatId, "🏢 شرکت صادرکننده را انتخاب کنید:", {
      reply_markup: inlineKeyboard([
        ...COMPANY_ORDER.map((key) => [{ text: COMPANIES[key].label, callback_data: `company:${key}` }]),
        [{ text: "❌ لغو", callback_data: "cancel" }],
      ]),
    });
  }

  async promptItemDescription(chatId, token, state) {
    const n = toPersianDigits(state.items.length + 1);
    await sendMessage(token, chatId, `📦 شرح کالا یا خدمت ردیف ${n} را وارد کنید:`, {
      reply_markup: backAndCancelKeyboard(),
    });
  }

  async promptItemMore(chatId, token) {
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
      case "customer_name":
        await sendMessage(token, chatId, "👤 نام مشتری (خریدار) را وارد کنید:", {
          reply_markup: backAndCancelKeyboard(),
        });
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
    await sendChatAction(token, chatId, "upload_document").catch(() => {});
    try {
      const company = getCompany(state.companyKey);
      const [logoDataUri, stampDataUri, fontDataUri] = await Promise.all([
        loadDataUri(this.env, company.logo),
        state.includeStamp ? loadDataUri(this.env, company.stamp) : Promise.resolve(null),
        loadDataUri(this.env, "/fonts/vazirmatn-arabic-variable.woff2"),
      ]);

      const now = new Date();
      const jalaliParts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const jalaliYear = jalaliParts.find((p) => p.type === "year").value;
      const docDate = jalaliParts.map((p) => p.value).join("");

      const asciiYear = toAsciiDigits(jalaliYear);
      const counterStub = this.env.INVOICE_COUNTER.getByName("global");
      const seq = await counterStub.next(state.companyKey, asciiYear);
      const docNumber = `${jalaliYear}-${toPersianDigits(String(seq).padStart(3, "0"))}`;

      const items = state.items.map((it) => ({
        description: it.description,
        unit: "",
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
        items,
        includeStamp: !!state.includeStamp,
      });

      const pdfBytes = await renderInvoicePdf(this.env, html);
      const filename = `invoice-${state.companyKey}-${asciiYear}-${String(seq).padStart(3, "0")}.pdf`;

      await sendDocument(token, chatId, pdfBytes, filename, "🎉 پیش‌فاکتور شما آماده است.");
      await this.saveState(freshState());
      await sendMessage(token, chatId, "برای صدور فاکتور جدید، «➕ فاکتور جدید» را بزنید.", {
        reply_markup: MAIN_MENU,
      });
    } catch (err) {
      console.error("generateAndSendInvoice failed:", err);
      const retryState = this.advance(state, (s) => {
        s.step = "ask_stamp";
        return s;
      });
      await this.saveState(retryState);
      await sendMessage(
        token,
        chatId,
        "⚠️ در تولید فایل PDF مشکلی پیش آمد. لطفاً دوباره تلاش کنید."
      );
      await this.promptStamp(chatId, token);
    }
  }
}
