declare module "*/attention-action-labels.mjs" {
  export const ACTION_LABELS: Record<string, string>;

  export function actionLabel(action: string): string;
}

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
    | {
      mode: "unavailable";
      attentionId: string | null;
      iapHelperCommand: string;
      localUrl: string;
      note: string;
      message: string;
    }
    | { mode: "error"; error: string };

  export function liveBrowserUnavailableMessage(): string;

  export function liveBrowserLoadFailedMessage(): string;

  export function defaultIapHelperCommand(): string;

  export function buildLiveSessionProxyPath(
    attentionId: string,
    magicToken: string,
    options?: { embed?: boolean },
  ): string;

  export function buildLiveSessionProxyUrl(
    publicSiteUrl: string,
    attentionId: string,
    magicToken: string,
    options?: { embed?: boolean },
  ): string;

  export const LIVE_SESSION_TRYCLOUDFLARE_FRAME_SRC: string;

  export function liveSessionFrameSrcOrigins(liveSessionBaseUrl: string): string[];

  export function liveSessionConnectSrcOrigins(liveSessionBaseUrl: string): string[];

  export function wantsLiveSessionEmbed(url: URL): boolean;
}

declare module "*/attention-wake.mjs" {
  export function validateAttentionWakeRequest(input: unknown):
    | {
      ok: true;
      data: { attentionId: string; reason: string; source: string };
    }
    | { ok: false; error: string; status: number };

  export function defaultWakeInstructions(): string;

  export function buildAttentionWakePayload(input: {
    attentionId: string;
    reason?: string;
    source?: string;
    now?: string;
  }): {
    type: "attention_wake";
    attentionId: string;
    reason: string;
    source: string;
    requestedAt: string;
  };

  export function formatWakeStatusMessage(
    status: "dispatched" | "recorded" | "failed" | "starting" | "connecting" | string,
  ): string;

  export function dispatchAttentionWake(config: {
    attentionId: string;
    reason?: string;
    source?: string;
    wakeUrl?: string;
    wakeInstructions?: string;
    notifySecret?: string;
    fetchImpl?: typeof fetch;
    logger?: { error?: (message: string) => void; warn?: (message: string) => void };
  }): Promise<
    | {
      ok: true;
      attentionId: string;
      status: "dispatched" | "recorded";
      message: string;
      instructions: string | null;
      payload: {
        type: "attention_wake";
        attentionId: string;
        reason: string;
        source: string;
        requestedAt: string;
      };
    }
    | {
      ok: false;
      error: string;
      status?: number;
      attentionId?: string;
      message?: string;
      instructions?: string | null;
      payload?: {
        type: "attention_wake";
        attentionId: string;
        reason: string;
        source: string;
        requestedAt: string;
      };
    }
  >;
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
    questions: { id: string; prompt: string; kind: string; required: boolean }[];
    aiAssistanceDiscouraged: boolean;
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
      questions?: { id?: string; prompt?: string; kind?: string; required?: boolean }[];
      aiAssistanceDiscouraged?: boolean;
      postingText?: string;
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
        questions: { id: string; prompt: string; kind: string; required: boolean }[];
        aiAssistanceDiscouraged: boolean;
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
      questions: { id: string; prompt: string; kind: string; required: boolean }[];
      aiAssistanceDiscouraged: boolean;
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
    | {
      ok: true;
      data: {
        token: string;
        signal: string;
        action: string;
        answers: { questionId: string; text: string; source: string }[];
      };
    }
    | { ok: false; error: string; status: number };

  export function buildAttentionSignalRecord(
    attentionId: string,
    signal: string,
    meta?: {
      actor?: string;
      answers?: { questionId: string; text: string; source: string }[];
    },
  ): {
    attentionId: string;
    signal: string;
    actor: string;
    payload: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  };

  export function formatRunnerSignalPoll(record: {
    attentionId: string;
    signal: string;
    updatedAt?: string;
    payload?: Record<string, unknown>;
    answers?: { questionId: string; text: string; source: string }[];
  } | null): {
    attentionId: string | null;
    signal: string | null;
    pending: boolean;
    resumeRequested: boolean;
    skipped: boolean;
    aborted: boolean;
    updatedAt?: string;
    answers: { questionId: string; text: string; source: string }[];
    payload: Record<string, unknown>;
  };
}

declare module "*/attention-questions.mjs" {
  export function detectAiAssistanceDiscouraged(text: unknown): boolean;
  export function normalizeAttentionQuestions(raw: unknown): {
    id: string;
    prompt: string;
    kind: string;
    required: boolean;
  }[];
  export function normalizeAttentionAnswers(raw: unknown): {
    questionId: string;
    text: string;
    source: string;
  }[];
  export function fingerprintPrompt(prompt: string): string;
  export function suggestPriorAnswers(
    prompt: string,
    bank: { fingerprint?: string; prompt?: string; text?: string; tags?: string[] }[],
    options?: { limit?: number },
  ): { fingerprint: string; prompt: string; text: string; score: number }[];
  export function needsLiveBrowser(requiredActions?: string[]): boolean;
  export function hasJudgmentActions(requiredActions?: string[]): boolean;
}

declare module "*/attention-draft.mjs" {
  export function resolveDraftConfig(config?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }): { configured: boolean; apiKey: string; baseUrl: string; model: string };

  export function buildHeuristicDraft(input: {
    prompt: string;
    company?: string;
    role?: string;
    candidateNotes?: string;
  }): string;

  export function humanizeDraftText(text: string): string;

  export function draftAttentionAnswer(
    input: {
      prompt: string;
      company?: string;
      role?: string;
      candidateNotes?: string;
      aiAssistanceDiscouraged?: boolean;
    },
    config?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      fetchImpl?: typeof fetch;
    },
  ): Promise<
    | { ok: true; draft: string; model: string; note: string }
    | {
      ok: false;
      error: string;
      status?: number;
      message?: string;
      heuristic?: string;
    }
  >;
}
