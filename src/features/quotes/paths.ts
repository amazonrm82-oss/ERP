/** QUO-01, QUO-02: the quote editor. */
export const quotePath = (orgId: string, quoteId: string) => `/o/${orgId}/quotes/${quoteId}`;

/** QUO-04: the business's quote templates (settings). */
export const quoteTemplatesPath = (orgId: string) => `/o/${orgId}/settings/quote-templates`;
