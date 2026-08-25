import { describe, it, expect } from "vitest";
import {
  toPersianDigits,
  toAsciiDigits,
  parseQtyMilli,
  parseMoneyBig,
  formatBigRial,
  formatQtyMilli,
  bigRoundDiv,
  rialToWordsBig,
} from "../src/lib/persianNumbers.js";

describe("digit conversion", () => {
  it("converts ASCII digits to Persian", () => {
    expect(toPersianDigits("12345")).toBe("۱۲۳۴۵");
  });

  it("converts Persian digits back to ASCII", () => {
    expect(toAsciiDigits("۱۲۳۴۵")).toBe("12345");
  });
});

describe("parseMoneyBig (validation)", () => {
  it("parses a plain integer", () => {
    expect(parseMoneyBig("150000")).toBe(150000n);
  });

  it("parses Persian digits with grouping separators", () => {
    expect(parseMoneyBig("۱۵۰٬۰۰۰")).toBe(150000n);
  });

  it("rejects empty input", () => {
    expect(parseMoneyBig("")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseMoneyBig("abc")).toBeNull();
  });
});

describe("parseQtyMilli (validation)", () => {
  it("parses an integer quantity", () => {
    expect(parseQtyMilli("10")).toBe(10000n);
  });

  it("parses a decimal quantity to 3 places", () => {
    expect(parseQtyMilli("2.5")).toBe(2500n);
  });

  it("rejects invalid input", () => {
    expect(parseQtyMilli("--")).toBeNull();
  });
});

describe("formatting", () => {
  it("formats Rial amounts with grouping", () => {
    expect(formatBigRial(1500000n)).toBe(toPersianDigits("1,500,000".replace(/,/g, "٬")));
  });

  it("formats quantities, trimming trailing zeros", () => {
    expect(formatQtyMilli(2500n)).toBe(toPersianDigits("2.5".replace(".", "٫")));
    expect(formatQtyMilli(10000n)).toBe(toPersianDigits("10"));
  });
});

describe("bigRoundDiv", () => {
  it("rounds half-up", () => {
    expect(bigRoundDiv(5n, 2n)).toBe(3n);
    expect(bigRoundDiv(4n, 2n)).toBe(2n);
  });
});

describe("line total math (qtyMilli * priceRial / 1000)", () => {
  it("computes an exact line total for 2.5 x 1,500,000", () => {
    const qtyMilli = parseQtyMilli("2.5");
    const price = parseMoneyBig("1500000");
    const total = bigRoundDiv(qtyMilli * price, 1000n);
    expect(total).toBe(3750000n);
  });
});

describe("rialToWordsBig", () => {
  it("spells out zero", () => {
    expect(rialToWordsBig(0n)).toBe("صفر ریال");
  });

  it("spells out a simple amount", () => {
    expect(rialToWordsBig(1500000n)).toBe("یک میلیون و پانصد هزار ریال");
  });
});
