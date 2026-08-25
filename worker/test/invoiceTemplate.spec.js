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
		// Buyer field values render as empty <span>s — no "N/A", "-", or similar filler.
		expect(html).not.toMatch(/N\/A|نامشخص|—|ندارد/);
	});
});
