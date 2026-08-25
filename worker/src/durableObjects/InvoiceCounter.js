import { DurableObject } from "cloudflare:workers";

/**
 * A single global Durable Object instance (see env.INVOICE_COUNTER.getByName
 * ("global") in index.js) that hands out sequential, per-company, per-year
 * invoice numbers. Centralizing this in one DO — rather than counting inside
 * each per-chat InvoiceSession — is what keeps numbers unique across
 * different chats/sales agents issuing invoices for the same company.
 */
export class InvoiceCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async next(companyKey, yearKey) {
    const key = `seq:${companyKey}:${yearKey}`;
    const current = (await this.ctx.storage.get(key)) || 0;
    const nextValue = current + 1;
    await this.ctx.storage.put(key, nextValue);
    return nextValue;
  }
}
