/**
 * Design-only attention fixtures for Quiet Trust UI review.
 * Known `?design=` keys skip the magic-link gate and never hit signal/wake/apply APIs.
 * Invalid or missing design keys fall through to normal token auth.
 */

import { liveBrowserLoadFailedMessage, liveBrowserUnavailableMessage } from "./attention-live-session.mjs";
import { BLOCKER_COPY } from "./attention-mail.mjs";

/** Stable path id for Design harness URLs: `/attention/design?design=<key>`. */
export const ATTENTION_DESIGN_FIXTURE_ID = "design";

export const ATTENTION_DESIGN_FIXTURE_KEYS = Object.freeze([
  "questions",
  "live-required",
  "unavailable",
  "retry",
  "resume-requested",
]);

const FIXTURE_SET = new Set(ATTENTION_DESIGN_FIXTURE_KEYS);

/** Buyer-safe resume confirmation (matches POST /api/attention/:id/signal). */
export function attentionResumeRequestedNote() {
  return "Resume requested. Your answers will be used on the open application page. Filling a form is not an application until you see confirmation on the employer site.";
}

/**
 * @param {unknown} searchParams
 * @returns {string | null}
 */
export function parseAttentionDesignKey(searchParams) {
  const params = searchParams && typeof searchParams === "object" ? searchParams : {};
  const raw = params.design;
  const design = Array.isArray(raw) ? raw[0] : raw;
  if (typeof design !== "string") return null;
  const key = design.trim().toLowerCase();
  return FIXTURE_SET.has(key) ? key : null;
}

/**
 * @param {unknown} searchParams
 * @returns {ReturnType<typeof buildAttentionDesignFixture>}
 */
export function resolveAttentionDesignFixture(searchParams) {
  const key = parseAttentionDesignKey(searchParams);
  if (!key) return null;
  return buildAttentionDesignFixture(key);
}

/**
 * @param {string} key
 * @returns {{
 *   key: string,
 *   view: {
 *     attentionId: string,
 *     company: string,
 *     role: string,
 *     url: string,
 *     stage: string,
 *     blocker: string,
 *     requiredActions: string[],
 *     questions: { id: string, prompt: string, kind: string, required: boolean }[],
 *     aiAssistanceDiscouraged: boolean,
 *     why: string,
 *     liveSessionUrl: string | null,
 *     liveSessionEmbedUrl: string | null,
 *     liveSessionAvailable: boolean,
 *     token: string,
 *     expiresAt: number,
 *   },
 *   ui: {
 *     panelOpen: boolean,
 *     loadFailed: boolean,
 *     connecting: boolean,
 *     status: string | null,
 *     iframeSrc: string | null,
 *   },
 * } | null}
 */
export function buildAttentionDesignFixture(key) {
  if (!FIXTURE_SET.has(key)) return null;

  const base = {
    attentionId: ATTENTION_DESIGN_FIXTURE_ID,
    company: "Acme Robotics",
    role: "Forward Deployed Engineer",
    url: "https://jobs.example.com/apply/acme-fde",
    stage: "submission",
    aiAssistanceDiscouraged: false,
    token: "design-fixture",
    expiresAt: Date.now() + 60 * 60 * 1000,
    /** Stub only — CTAs are no-ops; never a real live-session proxy. */
    liveSessionUrl: "#design-fixture-live",
    liveSessionEmbedUrl: "about:blank",
  };

  switch (key) {
    case "questions": {
      const requiredActions = ["provide-judgment"];
      const blocker = "judgment";
      const questions = [
        {
          id: "why-us",
          prompt: "Why this role at Acme Robotics?",
          kind: "why-us",
          required: true,
        },
        {
          id: "proud-project",
          prompt: "Tell us about a project you are proud of.",
          kind: "proud-project",
          required: true,
        },
      ];
      return {
        key,
        view: {
          ...base,
          blocker,
          requiredActions,
          questions,
          why: BLOCKER_COPY[blocker] ?? BLOCKER_COPY.other,
          liveSessionAvailable: true,
        },
        ui: {
          panelOpen: false,
          loadFailed: false,
          connecting: false,
          status: null,
          iframeSrc: null,
        },
      };
    }
    case "live-required": {
      const requiredActions = ["complete-captcha"];
      const blocker = "captcha";
      return {
        key,
        view: {
          ...base,
          blocker,
          requiredActions,
          questions: [],
          why: BLOCKER_COPY[blocker] ?? BLOCKER_COPY.other,
          liveSessionAvailable: true,
        },
        ui: {
          panelOpen: false,
          loadFailed: false,
          connecting: false,
          status: null,
          iframeSrc: null,
        },
      };
    }
    case "unavailable": {
      const requiredActions = ["complete-captcha"];
      const blocker = "captcha";
      return {
        key,
        view: {
          ...base,
          blocker,
          requiredActions,
          questions: [],
          why: BLOCKER_COPY[blocker] ?? BLOCKER_COPY.other,
          liveSessionAvailable: false,
        },
        ui: {
          panelOpen: true,
          loadFailed: false,
          connecting: false,
          status: null,
          iframeSrc: null,
        },
      };
    }
    case "retry": {
      const requiredActions = ["complete-captcha"];
      const blocker = "captcha";
      return {
        key,
        view: {
          ...base,
          blocker,
          requiredActions,
          questions: [],
          why: BLOCKER_COPY[blocker] ?? BLOCKER_COPY.other,
          liveSessionAvailable: true,
        },
        ui: {
          panelOpen: true,
          loadFailed: true,
          connecting: false,
          status: null,
          iframeSrc: "about:blank",
        },
      };
    }
    case "resume-requested": {
      const requiredActions = ["provide-judgment"];
      const blocker = "judgment";
      const questions = [
        {
          id: "why-us",
          prompt: "Why this role at Acme Robotics?",
          kind: "why-us",
          required: true,
        },
      ];
      return {
        key,
        view: {
          ...base,
          blocker,
          requiredActions,
          questions,
          why: BLOCKER_COPY[blocker] ?? BLOCKER_COPY.other,
          liveSessionAvailable: true,
        },
        ui: {
          panelOpen: false,
          loadFailed: false,
          connecting: false,
          status: attentionResumeRequestedNote(),
          iframeSrc: null,
        },
      };
    }
    default: {
      const _exhaustive = key;
      void _exhaustive;
      return null;
    }
  }
}

/** Copy anchors Design / tests can assert without importing React. */
export function attentionDesignFixtureCopy(key) {
  switch (key) {
    case "unavailable":
      return liveBrowserUnavailableMessage();
    case "retry":
      return liveBrowserLoadFailedMessage();
    case "resume-requested":
      return attentionResumeRequestedNote();
    case "questions":
    case "live-required":
      return null;
    default:
      return null;
  }
}
