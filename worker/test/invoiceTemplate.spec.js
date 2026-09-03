import { describe, it, expect } from "vitest";
import { buildInvoiceHtml } from "../src/lib/invoiceTemplate.js";

function baseInvoiceData(overrides = {}) {
	return {
		company: { name: "شرکت فروشنده", address: "", postalCode: "", nationalId: "", phones: "", website: "" },
		fontDataUri: "data:font/woff2;base64,",
		docNumber: "۱۴۰۳-۰۰۱",
		docDate: "۱۴۰۳/۰۱/۰۱",
		validity: "پایان روز جاری",
		buyerName: "مشتری تست",
		items: [{ description: "کالای تست", unit: "", quantityMilli: 1000n, unitPriceRial: 1000n }],
		includeStamp: false,
		...overrides,
	};
}

describe("buildInvoiceHtml buyer details", () => {
	it("renders the buyer detail fields when provided", () => {
		const html = buildInvoiceHtml(
			baseInvoiceData({
				buyerAddress: "تهران، خیابان آزادی",
				buyerPostalCode: "۱۲۳۴۵۶۷۸۹۰",
				buyerNationalId: "۱۰۹۸۷۶۵۴۳۲۱",
				buyerPhone: "۰۲۱-۱۲۳۴۵۶۷۸",
			})
		);
		expect(html).toContain("تهران، خیابان آزادی");
		expect(html).toContain("۱۲۳۴۵۶۷۸۹۰");
		expect(html).toContain("۱۰۹۸۷۶۵۴۳۲۱");
		expect(html).toContain("۰۲۱-۱۲۳۴۵۶۷۸");
	});

	it("leaves skipped buyer detail fields empty with no placeholder text", () => {
		const html = buildInvoiceHtml(baseInvoiceData());
		// Scoped to the party cards, not the whole document: the stylesheet is
		// embedded in the page and its comments are prose, em dashes and all.
		const parties = html.slice(html.indexOf('<section class="inv-parties">'), html.indexOf("</section>", html.indexOf("مشخصات خریدار")));
		expect(parties).toContain("مشخصات خریدار");
		// Buyer field values render as empty <span>s — no "N/A", "-", or similar filler.
		expect(parties).not.toMatch(/N\/A|نامشخص|—|ندارد/);
	});
});

describe("buildInvoiceHtml items table", () => {
	it("carries no discount column, computed partner, or totals row", () => {
		const html = buildInvoiceHtml(baseInvoiceData());
		// The desktop app retired تخفیف / مبلغ پس از تخفیف; this template mirrors
		// its sheet, so the two documents must have the same six columns.
		expect(html).not.toContain("تخفیف");
		expect(html).not.toContain("col-discount");
		expect(html).not.toContain("col-net");
		const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((match) => match[1]);
		expect(headers).toEqual([
			"ردیف",
			"شرح کالا یا خدمات",
			"تعداد / مقدار",
			"واحد",
			"مبلغ واحد (ریال)",
			"مبلغ کل (ریال)",
		]);
	});
});

describe("buildInvoiceHtml tax & totals", () => {
	it("renders 10% tax and adds it to net total when specified", () => {
		const html = buildInvoiceHtml(baseInvoiceData({
			items: [{ description: "کالا", unit: "عدد", quantityMilli: 1000n, unitPriceRial: 1000000n }],
			taxPercent: 10,
		}));
		expect(html).toContain("جمع کل</span><strong>۱٬۰۰۰٬۰۰۰ ریال</strong>");
		expect(html).toContain("مالیات و عوارض (٪۱۰)</span><strong>۱۰۰٬۰۰۰ ریال</strong>");
		expect(html).toContain("مبلغ قابل پرداخت</span><strong>۱٬۱۰۰٬۰۰۰ ریال</strong>");
	});

	it("renders 0% tax when tax is zero", () => {
		const html = buildInvoiceHtml(baseInvoiceData({
			items: [{ description: "کالا", unit: "عدد", quantityMilli: 1000n, unitPriceRial: 1000000n }],
			taxPercent: 0,
		}));
		expect(html).toContain("مالیات و عوارض (٪۰)</span><strong>۰ ریال</strong>");
		expect(html).toContain("مبلغ قابل پرداخت</span><strong>۱٬۰۰۰٬۰۰۰ ریال</strong>");
	});

	it("safely handles Persian digit tax strings without throwing RangeError", () => {
		const html = buildInvoiceHtml(baseInvoiceData({
			items: [{ description: "کالا", unit: "عدد", quantityMilli: 1000n, unitPriceRial: 1000000n }],
			taxPercent: "۱۰",
		}));
		expect(html).toContain("مالیات و عوارض (٪۱۰)</span><strong>۱۰۰٬۰۰۰ ریال</strong>");
		expect(html).toContain("مبلغ قابل پرداخت</span><strong>۱٬۱۰۰٬۰۰۰ ریال</strong>");
	});

	it("leaves filler row total cell empty rather than printing zero", () => {
		const html = buildInvoiceHtml(baseInvoiceData({
			items: [{ description: "کالا", unit: "عدد", quantityMilli: 1000n, unitPriceRial: 1000000n }],
		}));
		expect(html).toContain('<td class="col-total cell-computed"></td>');
		expect(html).not.toMatch(/<td class="col-total cell-computed">۰<\/td>/);
	});

	it("renders decimal tax percent with Persian momayyez separator", () => {
		const html = buildInvoiceHtml(baseInvoiceData({
			items: [{ description: "کالا", unit: "عدد", quantityMilli: 1000n, unitPriceRial: 1000000n }],
			taxPercent: 10.5,
		}));
		expect(html).toContain("مالیات و عوارض (٪۱۰٫۵)</span><strong>۱۰۵٬۰۰۰ ریال</strong>");
		expect(html).not.toContain("٪۱۰.5");
	});

	it("omits the logo chip completely when company has no logo", () => {
		const html = buildInvoiceHtml(baseInvoiceData({
			company: { name: "شرکت بدون آرم", logoDataUri: null },
		}));
		expect(html).not.toContain('class="inv-logo-chip"');
	});
});

