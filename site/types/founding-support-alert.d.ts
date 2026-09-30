declare module "*/founding-support-alert.mjs" {
  export const DEFAULT_FOUNDING_SUPPORT_ALERT_EMAIL: string;
  export function buildFoundingSupportAlert(input: {
    purchaseId: string;
    customerEmail?: string | null;
    paymentId?: string | null;
    amount?: number | null;
    currency?: string | null;
    eventType?: string | null;
  }): {
    subject: string;
    text: string;
    html: string;
    purchaseId: string | null;
    customerEmail: string | null;
    paymentId: string | null;
  };
  export function logFoundingSupportAlert(
    alert: {
      subject: string;
      purchaseId: string | null;
      customerEmail: string | null;
      paymentId: string | null;
    },
    config?: { logger?: { info?: (message: string) => void; error?: (message: string) => void; warn?: (message: string) => void } },
  ): {
    type: string;
    purchaseId: string | null;
    buyerEmail: string | null;
    paymentId: string | null;
    subject: string;
  };
  export function sendFoundingSupportAlert(
    input: {
      purchaseId: string;
      customerEmail?: string | null;
      paymentId?: string | null;
      amount?: number | null;
      currency?: string | null;
      eventType?: string | null;
    },
    config?: {
      apiKey?: string;
      from?: string;
      to?: string;
      fetchImpl?: typeof fetch;
      logger?: { info?: (message: string) => void; error?: (message: string) => void; warn?: (message: string) => void };
    },
  ): Promise<{
    ok: boolean;
    channel?: string;
    id?: string | null;
    subject?: string;
    error?: string;
    status?: number;
    logged?: unknown;
  }>;
}

declare module "*/founding-payment-ops.mjs" {
  export function handleFoundingPaymentWebhook(deps: {
    eventId: string;
    payment: {
      eventType: string;
      purchaseId: string | null;
      paymentId: string;
      customerEmail?: string | null;
      status: string | null;
      amount?: number | null;
      currency?: string | null;
      [key: string]: unknown;
    };
    persist: (
      eventId: string,
      payment: {
        eventType: string;
        purchaseId: string | null;
        paymentId: string;
        customerEmail?: string | null;
        status: string | null;
        amount?: number | null;
        currency?: string | null;
        [key: string]: unknown;
      },
    ) => Promise<{ isNewEvent?: boolean } | void>;
    alertSupport: (input: {
      purchaseId: string;
      customerEmail: string | null;
      paymentId: string | null;
      amount: number | null;
      currency: string | null;
      eventType: string;
    }) => Promise<unknown>;
    activatePurchase?: (purchaseId: string) => Promise<unknown>;
  }): Promise<{
    purchaseUpdated: true;
    activated: false;
    isNewEvent: boolean;
    alert: unknown;
  }>;
}
