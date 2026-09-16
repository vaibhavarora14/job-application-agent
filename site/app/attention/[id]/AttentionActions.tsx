"use client";

import { useState } from "react";
import { formatWakeStatusMessage } from "../../../lib/attention-wake.mjs";

type AttentionView = {
  attentionId: string;
  company: string;
  role: string;
  url: string;
  stage: string;
  blocker: string;
  requiredActions: string[];
  why: string;
  liveSessionUrl: string | null;
  liveSessionEmbedUrl: string | null;
  token: string;
  expiresAt: number;
};

type SignalResponse = {
  error?: string;
  note?: string;
  signal?: string;
};

type WakeResponse = {
  error?: string;
  message?: string;
  status?: string;
  instructions?: string | null;
};

export function AttentionActions({ view }: { view: AttentionView }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [wakeStatus, setWakeStatus] = useState<string | null>(null);
  const [wakeInstructions, setWakeInstructions] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  async function send(action: "resume" | "skip" | "abort") {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/attention/${encodeURIComponent(view.attentionId)}/signal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: view.token, action }),
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

  async function openLivePanel() {
    if (!view.liveSessionEmbedUrl) {
      setError("Magic-link token missing for live session.");
      return;
    }
    setOpening(true);
    setError(null);
    setWakeStatus(formatWakeStatusMessage("starting"));
    setPanelOpen(true);

    try {
      const wakeResponse = await fetch(`/api/attention/${encodeURIComponent(view.attentionId)}/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: view.token }),
      });
      const wakeBody = await wakeResponse.json() as WakeResponse;
      if (typeof wakeBody.message === "string") {
        setWakeStatus(wakeBody.message);
      } else if (wakeResponse.ok) {
        setWakeStatus(formatWakeStatusMessage("recorded"));
      } else {
        setWakeStatus(formatWakeStatusMessage("failed"));
      }
      if (typeof wakeBody.instructions === "string" && wakeBody.instructions.trim()) {
        setWakeInstructions(wakeBody.instructions);
      } else {
        setWakeInstructions(null);
      }
    } catch {
      setWakeStatus(formatWakeStatusMessage("failed"));
    }

    // Load the same-origin embed shell (verifies token, injects noVNC password in fragment).
    setIframeSrc(view.liveSessionEmbedUrl);
    setOpening(false);
  }

  function closeLivePanel() {
    setPanelOpen(false);
    setPanelExpanded(false);
    setIframeSrc(null);
  }

  return (
    <div className="attention-actions-stack">
      <div className="attention-actions">
        {view.liveSessionEmbedUrl ? (
          <button
            type="button"
            className="button"
            disabled={opening}
            onClick={() => (panelOpen ? closeLivePanel() : openLivePanel())}
          >
            {opening ? "Starting…" : panelOpen ? "Hide live browser" : "Open live browser"}
          </button>
        ) : (
          <button type="button" className="button" disabled title="Magic-link token missing for live session">
            Open live browser
          </button>
        )}
        {panelOpen && view.liveSessionUrl ? (
          <a className="button button-secondary" href={view.liveSessionUrl} target="_blank" rel="noreferrer">
            Open in new tab
          </a>
        ) : null}
        {panelOpen ? (
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
        {wakeStatus ? <p className="attention-wake-status" role="status">{wakeStatus}</p> : null}
      </div>

      {panelOpen ? (
        <section
          className={panelExpanded ? "attention-live-panel attention-live-panel-expanded" : "attention-live-panel"}
          aria-label="Live remote browser"
        >
          <div className="attention-live-panel-chrome">
            <p className="attention-live-panel-label">Live browser</p>
            <p className="attention-live-panel-hint">
              Finish the paused step here. filled ≠ applied until you resume and the runner confirms visible success.
            </p>
          </div>
          {wakeInstructions ? (
            <pre className="attention-wake-instructions">{wakeInstructions}</pre>
          ) : null}
          {iframeSrc ? (
            <iframe
              className="attention-live-frame"
              title="Remote live browser"
              src={iframeSrc}
              allow="clipboard-read; clipboard-write"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="attention-live-frame attention-live-frame-pending" role="status">
              Starting live browser…
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
