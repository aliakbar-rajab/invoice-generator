import { describe, it, expect } from "vitest";
import { COMPANIES, COMPANY_ORDER, getCompany, OTHER_COMPANY_KEY, buildCustomCompany } from "../src/lib/companies.js";

describe("companies", () => {
	it("keeps the existing two issuer companies untouched", () => {
		expect(COMPANY_ORDER).toEqual(["fouladBonyan", "karaBorjParseh"]);
		expect(getCompany("fouladBonyan")).toBe(COMPANIES.fouladBonyan);
		expect(getCompany("karaBorjParseh")).toBe(COMPANIES.karaBorjParseh);
	});

	it("returns null for an unknown key", () => {
		expect(getCompany("nope")).toBeNull();
		expect(getCompany(OTHER_COMPANY_KEY)).toBeNull();
	});

	it("builds a custom company profile from a user-typed name", () => {
		const company = buildCustomCompany("شرکت تست");
		expect(company.key).toBe(OTHER_COMPANY_KEY);
		expect(company.name).toBe("شرکت تست");
		expect(company.type).toBe("سایر");
		expect(company.label).toBe("سایر");
	});

	it("leaves identity fields blank for a custom company", () => {
		const company = buildCustomCompany("شرکت تست");
		expect(company.logo).toBeNull();
		expect(company.stamp).toBeNull();
		expect(company.address).toBe("");
		expect(company.postalCode).toBe("");
		expect(company.nationalId).toBe("");
		expect(company.phones).toBe("");
		expect(company.website).toBe("");
	});
});
