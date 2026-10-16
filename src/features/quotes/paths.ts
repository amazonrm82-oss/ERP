/** QUO-01, QUO-02: the quote editor. */
export const quotePath = (orgId: string, quoteId: string) => `/o/${orgId}/quotes/${quoteId}`;

/** QUO-04: the business's quote templates (settings). */
export const quoteTemplatesPath = (orgId: string) => `/o/${orgId}/settings/quote-templates`;

/** QUO-05: the design of quotes (settings) and a quote as its customer sees it. */
export const quoteDesignPath = (orgId: string) => `/o/${orgId}/settings/quote-design`;
export const quoteDocumentPath = (orgId: string, quoteId: string) => `/o/${orgId}/quotes/${quoteId}/document`;
