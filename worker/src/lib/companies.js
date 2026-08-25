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
