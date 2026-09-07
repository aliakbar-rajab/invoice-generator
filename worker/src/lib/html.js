/*
 * HTML escaping, shared by the two places that interpolate user text into
 * markup: the Telegram messages (all sent with parse_mode "HTML") and the
 * invoice template. A company name or a شرح containing "<" (لوله <2 اینچ>,
 * زاویه < 90) is markup until it is escaped — in a Telegram message that
 * made the API reject the whole send and left the conversation without the
 * keyboard it was about to show, i.e. stuck.
 *
 * Escape user text at every interpolation site; the surrounding template is
 * the only part that is allowed to be markup.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
