import { DurableObject } from "cloudflare:workers";

/**
 * A single global Durable Object instance (see env.INVOICE_COUNTER.getByName
 * ("global") in InvoiceSession.js) that hands out sequential, per-company,
 * per-year invoice numbers. Centralizing this in one DO — rather than
 * counting inside each per-chat InvoiceSession — is what keeps numbers
 * unique across different chats/sales agents issuing invoices for the same
 * company.
 */
export class InvoiceCounter extends DurableObject {
  async next(companyKey, yearKey) {
    const key = `seq:${companyKey}:${yearKey}`;
    const current = (await this.ctx.storage.get(key)) || 0;
    const nextValue = current + 1;
    await this.ctx.storage.put(key, nextValue);
    return nextValue;
  }

  /**
   * Hands a number back when the invoice it was drawn for was never issued —
   * a PDF render that failed, say (see generateAndSendInvoice's catch).
   * Without this, every retry retired another number and the sequence grew
   * permanent gaps, which is exactly what a sequential accounting number is
   * there to prevent.
   *
   * Deliberately conditional: it only rewinds while the caller still holds
   * the highest number issued. If another chat has already drawn past it, its
   * invoice is out in the world carrying that number and the gap is real —
   * rewinding then would hand a live number out twice, which is far worse
   * than a gap. Returns whether the rewind happened.
   */
  async release(companyKey, yearKey, value) {
    const key = `seq:${companyKey}:${yearKey}`;
    const current = (await this.ctx.storage.get(key)) || 0;
    if (current !== value) return false;
    await this.ctx.storage.put(key, value - 1);
    return true;
  }
}
