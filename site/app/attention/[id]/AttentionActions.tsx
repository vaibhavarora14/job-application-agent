"use client";

import { useEffect, useRef, useState } from "react";
import {
  liveBrowserLoadFailedMessage,
  liveBrowserUnavailableMessage,
} from "../../../lib/attention-live-session.mjs";
import { needsLiveBrowser } from "../../../lib/attention-questions.mjs";
import { AttentionAnswerFields, type AttentionQuestion } from "./AttentionAnswerFields";

type AttentionView = {
  attentionId: string;
  company: string;
  role: string;
  url: string;
  stage: string;
  blocker: string;
  requiredActions: string[];
  questions: AttentionQuestion[];
  aiAssistanceDiscouraged: boolean;
  why: string;
  liveSessionUrl: string | null;
  liveSessionEmbedUrl: string | null;
  /** True when ATTENTION_LIVE_SESSION_BASE_URL is configured on the Worker. */
  liveSessionAvailable: boolean;
  token: string;
  expiresAt: number;
};

type SignalResponse = {
  error?: string;
  note?: string;
  signal?: string;
};

type AnswerEntry = { text: string; source: "typed" | "draft_approved" | "bank" };

const CONNECTING_CLEAR_MS = 2500;
/** Soft blank watchdog — CSP blocks often never fire iframe onError. */
const LOAD_FAIL_MS = 12000;

export function AttentionActions({ view }: { view: AttentionView }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [answers, setAnswers] = useState<Record<string, AnswerEntry>>({});
  const clearConnectingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadFailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showLivePrimary = needsLiveBrowser(view.requiredActions);

  useEffect(() => {
    return () => {
      if (clearConnectingTimer.current) clearTimeout(clearConnectingTimer.current);
      if (loadFailTimer.current) clearTimeout(loadFailTimer.current);
    };
  }, []);

  function scheduleClearConnecting() {
    if (clearConnectingTimer.current) clearTimeout(clearConnectingTimer.current);
    clearConnectingTimer.current = setTimeout(() => {
      setConnecting(false);
      clearConnectingTimer.current = null;
    }, CONNECTING_CLEAR_MS);
  }

  function clearConnectingNow() {
    if (clearConnectingTimer.current) {
      clearTimeout(clearConnectingTimer.current);
      clearConnectingTimer.current = null;
    }
    setConnecting(false);
  }

  function clearLoadFailWatchdog() {
    if (loadFailTimer.current) {
      clearTimeout(loadFailTimer.current);
      loadFailTimer.current = null;
    }
  }

  function scheduleLoadFailWatchdog() {
    clearLoadFailWatchdog();
    loadFailTimer.current = setTimeout(() => {
      loadFailTimer.current = null;
      setLoadFailed(true);
      clearConnectingNow();
    }, LOAD_FAIL_MS);
  }

  function markFrameLoaded() {
    clearLoadFailWatchdog();
    clearConnectingNow();
    setLoadFailed(false);
  }

  function markFrameFailed() {
    clearLoadFailWatchdog();
    clearConnectingNow();
    setLoadFailed(true);
  }

  function setAnswer(questionId: string, text: string, source: AnswerEntry["source"]) {
    setAnswers((prev) => ({ ...prev, [questionId]: { text, source } }));
  }

  function missingRequiredAnswers() {
    return view.questions
      .filter((question) => question.required)
      .filter((question) => !String(answers[question.id]?.text ?? "").trim());
  }

  async function send(action: "resume" | "skip" | "abort") {
    setBusy(action);
    setError(null);
    try {
      if (action === "resume") {
        const missing = missingRequiredAnswers();
        if (missing.length) {
          setError(`Answer required: ${missing[0].prompt}`);
          setBusy(null);
          return;
        }
      }

      const payload: Record<string, unknown> = { token: view.token, action };
      if (action === "resume") {
        payload.answers = Object.entries(answers)
          .filter(([, entry]) => entry.text.trim())
          .map(([questionId, entry]) => ({
            questionId,
            text: entry.text.trim(),
            source: entry.source,
          }));
      }

      const response = await fetch(`/api/attention/${encodeURIComponent(view.attentionId)}/signal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as SignalResponse;
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "Signal failed.");
        return;
      }
      setStatus(typeof body.note === "string" ? body.note : `Recorded: ${body.signal ?? action}`);
    } catch {
      setError("Network error while recording your choice.");
    } finally {
      setBusy(null);
    }
  }

  function fireAndForgetWake() {
    void fetch(`/api/attention/${encodeURIComponent(view.attentionId)}/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: view.token }),
    }).catch(() => {
      /* ignore — buyer path does not depend on wake response */
    });
  }

  function mountLiveFrame() {
    if (!view.liveSessionEmbedUrl) return;
    setLoadFailed(false);
    setConnecting(true);
    scheduleClearConnecting();
    scheduleLoadFailWatchdog();
    setFrameKey((value) => value + 1);
    setIframeSrc(view.liveSessionEmbedUrl);
  }

  function openLivePanel() {
    if (!view.liveSessionEmbedUrl) {
      setError("Magic-link token missing for live session.");
      return;
    }
    setOpening(true);
    setError(null);
    setPanelOpen(true);

    fireAndForgetWake();

    if (!view.liveSessionAvailable) {
      clearLoadFailWatchdog();
      setIframeSrc(null);
      setConnecting(false);
      setLoadFailed(false);
      setOpening(false);
      return;
    }

    mountLiveFrame();
    setOpening(false);
  }

  function retryLivePanel() {
    fireAndForgetWake();
    mountLiveFrame();
  }

  function closeLivePanel() {
    clearConnectingNow();
    clearLoadFailWatchdog();
    setPanelOpen(false);
    setPanelExpanded(false);
    setIframeSrc(null);
    setLoadFailed(false);
  }

  const unavailableCopy = liveBrowserUnavailableMessage();
  const loadFailedCopy = liveBrowserLoadFailedMessage();
  const liveButtonClass = showLivePrimary ? "button" : "button button-secondary";

  return (
    <div className="attention-actions-stack">
      <AttentionAnswerFields
        attentionId={view.attentionId}
        token={view.token}
        questions={view.questions}
        aiAssistanceDiscouraged={view.aiAssistanceDiscouraged}
        answers={answers}
        onChange={setAnswer}
      />

      {!showLivePrimary && view.questions.length ? (
        <p className="attention-answers-lead">
          Live browser is optional unless CAPTCHA, MFA, or another unmirrorable step remains.
        </p>
      ) : null}

      <div className="attention-actions">
        {view.liveSessionEmbedUrl ? (
          <button
            type="button"
            className={liveButtonClass}
            disabled={opening}
            onClick={() => (panelOpen ? closeLivePanel() : openLivePanel())}
          >
            {opening ? "Starting…" : panelOpen ? "Hide live browser" : "Open live browser"}
          </button>
        ) : (
          <button type="button" className={liveButtonClass} disabled title="Magic-link token missing for live session">
            Open live browser
          </button>
        )}
        {panelOpen && view.liveSessionAvailable && view.liveSessionUrl ? (
          <a className="button button-secondary" href={view.liveSessionUrl} target="_blank" rel="noreferrer">
            Open in new tab
          </a>
        ) : null}
        {panelOpen && view.liveSessionAvailable ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setPanelExpanded((value) => !value)}
          >
            {panelExpanded ? "Exit full view" : "Expand live view"}
          </button>
        ) : null}
        <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => send("resume")}>
          {busy === "resume" ? "Recording…" : "I’ve finished — resume"}
        </button>
        <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => send("skip")}>
          {busy === "skip" ? "Recording…" : "Skip this role"}
        </button>
        <button type="button" className="button button-danger" disabled={Boolean(busy)} onClick={() => send("abort")}>
          {busy === "abort" ? "Recording…" : "Abort run"}
        </button>
        {error ? <p className="action-error" role="alert">{error}</p> : null}
        {status ? <p className="attention-status" role="status">{status}</p> : null}
        {connecting && !loadFailed ? <p className="attention-wake-status" role="status">Connecting…</p> : null}
      </div>

      {panelOpen ? (
        <section
          className={panelExpanded ? "attention-live-panel attention-live-panel-expanded" : "attention-live-panel"}
          aria-label="Live remote browser"
        >
          <div className="attention-live-panel-chrome">
            <p className="attention-live-panel-label">Live browser</p>
            <p className="attention-live-panel-hint">
              Finish CAPTCHA, MFA, or unmirrorable widgets here. Judgment answers above are injected on resume.
              filled ≠ applied until you resume and the runner confirms visible success.
            </p>
          </div>
          {!view.liveSessionAvailable ? (
            <div className="attention-live-unavailable" role="status">
              {unavailableCopy}
            </div>
          ) : iframeSrc ? (
            <div className={panelExpanded ? "attention-live-frame-wrap attention-live-frame-wrap-expanded" : "attention-live-frame-wrap"}>
              <iframe
                key={frameKey}
                className="attention-live-frame"
                title="Remote live browser"
                src={iframeSrc}
                allow="clipboard-read; clipboard-write"
                referrerPolicy="no-referrer"
                onLoad={() => markFrameLoaded()}
                onError={() => markFrameFailed()}
              />
              {loadFailed ? (
                <div className="attention-live-frame-fail" role="alert">
                  <p>{loadFailedCopy}</p>
                  <button type="button" className="button" onClick={retryLivePanel}>
                    Retry
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="attention-live-frame attention-live-frame-pending" role="status">
              Connecting…
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
