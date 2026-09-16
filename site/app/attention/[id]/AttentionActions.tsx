"use client";

import { useState } from "react";

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
  token: string;
  expiresAt: number;
};

type SignalResponse = {
  error?: string;
  note?: string;
  signal?: string;
};

export function AttentionActions({ view }: { view: AttentionView }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="attention-actions">
      {view.liveSessionUrl ? (
        <a className="button" href={view.liveSessionUrl} target="_blank" rel="noreferrer">
          Open live session
        </a>
      ) : (
        <button type="button" className="button" disabled title="Magic-link token missing for live session">
          Open live session
        </button>
      )}
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
    </div>
  );
}
