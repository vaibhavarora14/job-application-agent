"use client";

import { useState } from "react";

type CheckoutResult = { checkoutUrl?: string; error?: string };

export function FoundingCheckout({ compact = false }: { compact?: boolean }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");

  async function startCheckout() {
    setOpening(true); setError("");
    try {
      const response = await fetch("/api/checkout", { method: "POST" });
      const result = await response.json() as CheckoutResult;
      if (!response.ok || !result.checkoutUrl) throw new Error(result.error ?? "Secure checkout is temporarily unavailable.");
      window.location.assign(result.checkoutUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Secure checkout is temporarily unavailable.");
      setOpening(false);
    }
  }

  return <div className={`checkout-action${compact ? " checkout-action-compact" : ""}`}>
    <button className={`button${compact ? " button-small" : ""}`} type="button" onClick={startCheckout} disabled={opening}>
      {opening ? "Opening secure checkout…" : "Reserve 90-day access"}
    </button>
    {error && <p className="action-error" role="alert">{error}</p>}
  </div>;
}
