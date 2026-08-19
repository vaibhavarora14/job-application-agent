"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type View = "checking" | "paid" | "processing" | "failed";

export function PaymentReturnStatus() {
  const [view, setView] = useState<View>("checking");

  useEffect(() => {
    let attempts = 0;
    let active = true;
    let timer: number | undefined;
    const check = async () => {
      const purchaseId = new URLSearchParams(window.location.search).get("purchase_id");
      if (!purchaseId) { if (active) setView("failed"); return; }
      attempts += 1;
      try {
        const response = await fetch(`/api/checkout/status?purchase_id=${encodeURIComponent(purchaseId)}`, { cache: "no-store" });
        const result = await response.json() as { paid?: boolean; status?: string };
        if (!active) return;
        if (result.paid) { setView("paid"); return; }
        if (["failed", "cancelled", "refunded"].includes(result.status ?? "") || result.status?.startsWith("dispute_")) { setView("failed"); return; }
      } catch { /* Retry while Dodo delivers the verified webhook. */ }
      if (!active) return;
      if (attempts < 10) timer = window.setTimeout(check, 2000); else setView("processing");
    };
    void check();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, []);

  return <div className="payment-return-card" aria-live="polite">
    {view === "checking" && <><span className="live-dot"/><p className="eyebrow">Checking your payment</p><h1>Waiting for Dodo&apos;s verified webhook.</h1><p>Keep this page open. This normally takes only a few seconds.</p></>}
    {view === "paid" && <><span className="success-mark">✓</span><p className="eyebrow">Payment verified</p><h1>Your founding access is reserved.</h1><p>Your 90 days begin when access is activated. If activation has not happened within 60 days, the payment is automatically refunded.</p></>}
    {view === "processing" && <><p className="eyebrow">Still processing</p><h1>Your payment is still being confirmed.</h1><p>It is safe to close this page. Dodo will send a receipt when confirmation arrives.</p></>}
    {view === "failed" && <><p className="eyebrow">Not confirmed</p><h1>We could not verify this payment.</h1><p>No access has been granted. Return to the offer or contact Dodo Payments if you were charged.</p></>}
    <Link className="button button-secondary" href="/">Return to Job Application Agent</Link>
  </div>;
}
