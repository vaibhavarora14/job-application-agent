"use client";

import { useId, useState } from "react";
import { readUtmFromLocation } from "../../lib/landing-analytics.mjs";
import { FOUNDING_CTA_LABEL, FOUNDING_REGIONAL_PRICE_NOTE } from "../../lib/payment-core.mjs";
import { trackFoundingCtaClicked, useLandingAnalytics } from "./LandingAnalytics";

type CheckoutResult = { checkoutUrl?: string; error?: string };

export function FoundingCheckout({ compact = false }: { compact?: boolean }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const analytics = useLandingAnalytics();
  const noteId = useId();

  async function startCheckout() {
    setOpening(true); setError("");
    trackFoundingCtaClicked(analytics);
    try {
      const utm = readUtmFromLocation();
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(utm),
      });
      const result = await response.json() as CheckoutResult;
      if (!response.ok || !result.checkoutUrl) throw new Error(result.error ?? "Secure checkout is temporarily unavailable.");
      window.location.assign(result.checkoutUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Secure checkout is temporarily unavailable.");
      setOpening(false);
    }
  }

  return <div className={`checkout-action${compact ? " checkout-action-compact" : ""}`}>
    <button
      className={`button${compact ? " button-small" : ""}`}
      type="button"
      onClick={startCheckout}
      disabled={opening}
      aria-describedby={noteId}
    >
      {opening ? "Opening secure checkout…" : FOUNDING_CTA_LABEL}
    </button>
    <p id={noteId} className="checkout-regional-note">{FOUNDING_REGIONAL_PRICE_NOTE}</p>
    {error && <p className="action-error" role="alert">{error}</p>}
  </div>;
}
