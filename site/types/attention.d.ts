declare module "*/attention-live-session.mjs" {
  export function buildNoVncLiveSessionUrl(
    baseUrl: string,
    options?: { attentionId?: string; password?: string; autoconnect?: boolean },
  ): { ok: true; url: string; hasPassword: boolean } | { ok: false; error: string };

  export function resolveLiveSessionTarget(
    config: {
      liveSessionBaseUrl?: string;
      novncPassword?: string;
      iapHelperCommand?: string;
    },
    attentionId: string,
  ):
    | { mode: "redirect"; url: string; hasPassword: boolean; note: string }
    | { mode: "iap"; attentionId: string | null; iapHelperCommand: string; localUrl: string; note: string }
    | { mode: "error"; error: string };

  export function defaultIapHelperCommand(): string;

  export function buildLiveSessionProxyPath(attentionId: string, magicToken: string): string;

  export function buildLiveSessionProxyUrl(
    publicSiteUrl: string,
    attentionId: string,
    magicToken: string,
  ): string;
}

declare module "*/attention-magic-link.mjs" {
  export type AttentionMagicPayload = {
    attentionId: string;
    company: string;
    role: string;
    url: string;
    stage: string;
    blocker: string;
    requiredActions: string[];
    issuedAt: number;
    expiresAt: number;
  };

  export function signAttentionMagicLink(
    input: {
      attentionId?: string;
      company?: string;
      role?: string;
      url?: string;
      stage?: string;
      blocker?: string;
      requiredActions?: string[];
    },
    secret: string,
    options?: { ttlSeconds?: number; now?: number },
  ): Promise<
    | { ok: true; token: string; payload: Record<string, unknown>; expiresAt: number }
    | { ok: false; error: string }
  >;

  export function verifyAttentionMagicLink(
    token: string,
    secret: string,
    options?: { attentionId?: string; now?: number },
  ): Promise<
    | { ok: true; payload: AttentionMagicPayload }
    | { ok: false; error: string }
  >;

  export function buildAttentionMagicLinkUrl(
    publicSiteUrl: string,
    attentionId: string,
    token: string,
  ): string;
}

declare module "*/attention-mail.mjs" {
  export const BLOCKER_COPY: Record<string, string>;
  export const ACTION_LABELS: Record<string, string>;

  export function buildAttentionEmail(input: {
    company?: string;
    role?: string;
    blocker?: string;
    requiredActions?: string[];
    magicLinkUrl?: string;
  }): { subject: string; text: string; html: string; why: string };

  export function sendAttentionEmail(
    input: {
      to?: string;
      company?: string;
      role?: string;
      blocker?: string;
      requiredActions?: string[];
      magicLinkUrl?: string;
    },
    config?: {
      apiKey?: string;
      from?: string;
      fetchImpl?: typeof fetch;
      logger?: { error?: (message: string) => void; warn?: (message: string) => void };
    },
  ): Promise<{ ok: true; id: string | null; subject: string } | { ok: false; error: string; status?: number }>;
}

declare module "*/attention-notify.mjs" {
  export function validateAttentionNotifyRequest(input: unknown):
    | {
      ok: true;
      data: {
        attentionId: string;
        email: string;
        company: string;
        role: string;
        url: string;
        stage: string;
        blocker: string;
        requiredActions: string[];
      };
    }
    | { ok: false; error: string; status: number };

  export function notifyAttentionOpened(
    request: unknown,
    config: {
      magicLinkSecret?: string;
      publicSiteUrl?: string;
      resendApiKey?: string;
      resendFrom?: string;
      ttlSeconds?: number;
      fetchImpl?: typeof fetch;
      logger?: { error?: (message: string) => void; warn?: (message: string) => void };
    },
  ): Promise<
    | {
      ok: true;
      attentionId: string;
      emailId: string | null;
      subject: string;
      expiresAt: number;
      magicLinkUrl: string;
    }
    | { ok: false; error: string; status?: number }
  >;
}

declare module "*/attention-signals.mjs" {
  export const ATTENTION_SIGNAL_ACTIONS: {
    readonly resume_requested: "resume_requested";
    readonly skipped: "skipped";
    readonly aborted: "aborted";
  };

  export function validateAttentionSignalRequest(input: unknown):
    | { ok: true; data: { token: string; signal: string; action: string } }
    | { ok: false; error: string; status: number };

  export function buildAttentionSignalRecord(
    attentionId: string,
    signal: string,
    meta?: { actor?: string },
  ): {
    attentionId: string;
    signal: string;
    actor: string;
    createdAt: string;
    updatedAt: string;
  };

  export function formatRunnerSignalPoll(record: {
    attentionId: string;
    signal: string;
    updatedAt?: string;
  } | null): {
    attentionId: string | null;
    signal: string | null;
    pending: boolean;
    resumeRequested: boolean;
    skipped: boolean;
    aborted: boolean;
    updatedAt?: string;
  };
}
