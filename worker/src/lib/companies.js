/*
 * Issuer ("seller") company profiles. Ported verbatim from the desktop
 * invoice app's COMPANY_PROFILES (js/app.js) — same two companies, same
 * identity fields. Logo/stamp point at files copied into public/assets/
 * (served via the ASSETS binding, see src/lib/assets.js).
 */

export const COMPANIES = {
  fouladBonyan: {
    key: "fouladBonyan",
    label: "بنیان فولاد داریا",
    logo: "/assets/logo-foulad-bonyan-mark.png",
    stamp: "/assets/stamp-foulad-bonyan.png",
    name: "بنیان فولاد داریا",
    nationalId: "۱۴۰۱۵۴۸۳۱۸۶",
    address: "تهران، آجودانیه، پورابتهاج، نبش لشکری، ساختمان سرو، واحد ۳۰۳",
    postalCode: "۱۹۷۸۹۷۷۱۹۸",
    phones: "۰۲۱-۸۸۸۸۸۲۸۰ / ۰۲۱-۸۸۸۸۸۷۸۰ / ۰۲۱-۸۸۸۸۸۱۲۲",
    website: "www.fouladbonyan.com",
  },
  karaBorjParseh: {
    key: "karaBorjParseh",
    label: "کارا برج پارسه",
    logo: "/assets/logo-kara-borj-parseh.svg",
    stamp: "/assets/stamp-kara-borj-parseh.png",
    name: "کارا برج پارسه",
    nationalId: "۱۴۰۰۷۴۳۲۹۹۹",
    address: "تهران، آجودانیه، پورابتهاج، نبش لشکری، ساختمان سرو، واحد ۳۰۳",
    postalCode: "۱۹۷۸۹۷۷۱۹۸",
    phones: "۰۲۱-۸۸۸۸۸۲۸۰ / ۰۲۱-۸۸۸۸۸۷۸۰ / ۰۲۱-۸۸۸۸۸۱۲۲",
    website: "www.karaborj.com",
  },
};

export const COMPANY_ORDER = ["fouladBonyan", "karaBorjParseh"];

export function getCompany(key) {
  return Object.prototype.hasOwnProperty.call(COMPANIES, key) ? COMPANIES[key] : null;
}

// User-typed company name ("ورود نام شرکت" at /start). Internally tagged with
// the HTML/backend contract's "سایر" company type; that word is never shown
// to the Telegram user — only the typed name is.
export const OTHER_COMPANY_KEY = "other";
const OTHER_COMPANY_TYPE = "سایر";

export function buildCustomCompany(name) {
  return {
    key: OTHER_COMPANY_KEY,
    type: OTHER_COMPANY_TYPE,
    label: OTHER_COMPANY_TYPE,
    logo: null,
    stamp: null,
    name,
    nationalId: "",
    address: "",
    postalCode: "",
    phones: "",
    website: "",
  };
}
