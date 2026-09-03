# Domain Context: Offline Pishfaktor (پیش‌فاکتور آفلاین)

This document establishes the authoritative domain vocabulary, module seams, and architectural concepts for `offline-pishfaktor`.

---

## 1. Core Domain Concepts

### Invoice Document (`سند پیش‌فاکتور`)
The central aggregate of the system. Represents an editable or finalized Iranian pre-invoice document with:
- **Metadata (`داده‌های سربرگ`)**: Title (`عنوان سند`), Jalali issue date (`تاریخ`), sequential tracking number (`شماره پیش‌فاکتور`), and validity date/mode (`اعتبار پیش‌فاکتور`).
- **Parties (`طرفین معامله`)**: Seller (`فروشنده`) and Buyer (`خریدار`), each carrying legal identity fields: Name, National ID (`شناسه ملی`), Address (`نشانی`), Postal Code (`کد پستی`), and Phone (`تلفن`).
- **Item Rows (`اقلام کالا یا خدمات`)**: Ordered list of items with description (`شرح`), quantity (`تعداد/مقدار`), unit (`واحد`), and unit price (`مبلغ واحد`).
- **Financial Computations (`محاسبات مالی`)**: Row line totals, gross subtotal (`جمع کل`), value-added tax (`مالیات و عوارض`), net payable total (`مبلغ قابل پرداخت`), and Persian words transcript (`مبلغ به حروف`).
- **Document Directives (`تنظیمات ظاهری و چاپ`)**: Page orientation (`افقی/عمودی`), seller stamp visibility (`مهر فروشنده`), gray header background toggle, and notes text (`توضیحات`).

### Financial Typography & Precision (`محاسبات مالی و تایپوگرافی`)
- **Arbitrary-Precision Rial Arithmetic**: All money, unit prices, row sums, and tax totals are handled as exact BigInt representations in Iranian Rials (`ریال`) to avoid floating-point inaccuracies beyond `Number.MAX_SAFE_INTEGER`.
- **Quantity Scale**: Quantities are handled as fixed-point decimal values scaled to milli-units ($10^3$) with half-up rounding.
- **Tax Precision**: Tax percentages are represented in basis points ($10^2$ or $10^4$) to handle fractional rates (e.g. 10.5%).
- **Persian Transcoding & Words**: Strict ASCII-to-Persian/Arabic numeral transcoding and official Iranian accounting wording for currency amounts (`rialToWordsBig`).

### Document Store (`مخزن اسناد`)
The client-side persistence repository for invoices.
- **Independent Entry Storage**: Each invoice is stored under an independent key (`preinvoice.saved.entry.v2.<id>`) accompanied by an index record (`preinvoice.saved.v1`).
- **Concurrency & Versioning**: Every entry carries a monotonic `savedAt` timestamp. Multi-tab saves perform optimistic conflict detection, alerting the user if another tab wrote a newer version.
- **Storage Migration**: Automatically migrates legacy monolithic records (`preinvoice.autosave.v1`) to isolated entries without data loss.

### Company Profile (`پروفایل شرکت صادرکننده`)
Represents an issuer identity.
- **Built-in Profiles**: Preconfigured company identities (`fouladBonyan`, `karaBorjParseh`) shipping with fixed registration data, vector/bitmap logos, and official stamps.
- **Custom Profiles (`سایر`)**: User-defined companies created via the company editor, persisted in local storage along with company-specific logos and stamps.
- **Document Overrides**: Temporary, invoice-scoped logo/stamp images that apply only to the active document without altering the stored company profile.

### Print Layout & Vertical Rhythm (`طرح‌بندی چاپ و ریتم عمودی`)
The multi-page A4 document pagination and spacing engine.
- **Solved Vertical Rhythm**: Bisection algorithm that dynamically calculates `--print-density`, `--print-row-extra`, `--print-block-extra`, and `--doc-font-scale` to fill an A4 sheet completely without overflow or awkward white-space holes.
- **Multi-Page Relief**: When table rows or descriptions exceed single-page limits, trailing rows are cleanly allocated across consecutive continuation pages with continuation headers and page numbers.

### View Adapter (`آداپتور نمایشگر`)
The presentation layer interfacing between the user and domain modules.
- **Browser DOM Shell**: Standalone offline client (`app.js` and `persian-numbers.js`) orchestrating UI events, document persistence, arithmetic, and layout rhythm directly.
- **Telegram Bot / Worker Adapter**: Cloudflare Worker runtime translating Telegram bot webhook messages and callback queries into invoice document builds and PDF renders.

---

## 2. Architectural Design Vocabulary

All refactors and code reviews adhere strictly to the following vocabulary:
- **Module**: A unit of code with a well-defined interface and implementation.
- **Interface**: The formal boundary and methods through which callers invoke a module.
- **Depth**: The ratio of internal capability and invariant enforcement to interface surface. A deep module provides a simple interface that encapsulates rich internal logic.
- **Seam**: The line of separation between two distinct modules.
- **Adapter**: A translation layer between an external environment (DOM, Telegram, Puppeteer) and a module interface.
- **Leverage**: The architectural advantage achieved when a single deep interface serves multiple call sites with minimal surface.
- **Locality**: Ensuring related state, domain logic, and invariants concentrate in a single module rather than leaking across boundaries.
- **The Deletion Test**: Removing a module must concentrate complexity into its natural home, rather than scattering it.
