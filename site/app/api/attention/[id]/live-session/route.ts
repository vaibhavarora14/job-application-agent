import { attentionEnv } from "../../../../../lib/attention-auth";
import { verifyAttentionMagicLink } from "../../../../../lib/attention-magic-link.mjs";
import {
  liveBrowserUnavailableMessage,
  resolveLiveSessionTarget,
  wantsLiveSessionEmbed,
} from "../../../../../lib/attention-live-session.mjs";
import { dispatchAttentionWake } from "../../../../../lib/attention-wake.mjs";

type Params = { params: Promise<{ id: string }> };
type VerifyOk = { ok: true; payload: { attentionId: string } };
type VerifyErr = { ok: false; error: string };

/**
 * GET /api/attention/:id/live-session?token=…&embed=1
 *
 * Auth’d live-session entry: verify magic link, fire-and-forget wake, then
 * either embed noVNC in a same-origin shell (embed=1), 302 to noVNC (top-level),
 * or return buyer-facing unavailable HTML when ATTENTION_LIVE_SESSION_BASE_URL is unset.
 *
 * IAP / gcloud helpers are founder/dev-only (docs) — never returned on this buyer route.
 * Never emails VNC passwords. Full WebSocket proxy is out of scope.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const attentionId = decodeURIComponent(id ?? "").trim();
  if (!attentionId || attentionId.length > 180) {
    return Response.json({ error: "attention_id_invalid" }, { status: 400 });
  }

  const url = new URL(request.url);
  const token = (url.searchParams.get("token") ?? "").trim();
  if (!token) {
    return htmlResponse(400, "Missing live-session token",
      "Open the signed attention link from your email, then use Open live browser. VNC passwords are never emailed.");
  }

  const config = attentionEnv();
  const verified = await verifyAttentionMagicLink(token, config.magicLinkSecret, { attentionId }) as VerifyOk | VerifyErr;
  if (!verified.ok) {
    const title = verified.error === "token_expired"
      ? "This live-session link expired."
      : "This live-session link is not valid.";
    return htmlResponse(401, title,
      "Request a fresh attention notify from the hosted run. Lease hold is typically 45–60 minutes.");
  }

  const target = resolveLiveSessionTarget({
    liveSessionBaseUrl: config.liveSessionBaseUrl,
    novncPassword: config.novncPassword,
    iapHelperCommand: config.iapHelperCommand,
  }, attentionId);

  // Fire-and-forget wake for ops — never stall the buyer panel on wake recorded.
  void dispatchAttentionWake({
    attentionId,
    reason: "live_session",
    source: "live_session_route",
    wakeUrl: config.wakeUrl,
    wakeInstructions: config.wakeInstructions,
    notifySecret: config.notifySecret,
    logger: console,
  }).catch(() => {
    /* ignore — buyer path does not depend on wake */
  });

  const embed = wantsLiveSessionEmbed(url);

  if (target.mode === "error") {
    return htmlResponse(503, "Live browser unavailable", liveBrowserUnavailableMessage(), { embed: true });
  }

  if (target.mode === "redirect" && target.url) {
    if (embed) {
      return embedShellResponse({
        title: "Live browser",
        frameUrl: target.url,
        attentionId,
      });
    }
    return Response.redirect(target.url, 302);
  }

  // BASE_URL unset — soft buyer message only (IAP helper is founder/dev docs, not this surface).
  const unavailable = liveBrowserUnavailableMessage();
  return htmlResponse(503, "Live browser unavailable", `<p role="status">${escapeHtml(unavailable)}</p>`, {
    embed: Boolean(embed),
  });
}

function embedShellResponse(options: {
  title: string;
  frameUrl: string;
  attentionId?: string;
}) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="robots" content="noindex"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(options.title)} · JobAppAgent</title>
  <style>
    :root { color-scheme: light; --ink: #173F35; --muted: #73867F; --line: #D8CCB7; --bg: #F2E9D8; --surface: #FFFAF0; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font-family: "DM Sans", "Segoe UI", sans-serif; }
    .shell { display: flex; flex-direction: column; height: 100%; min-height: 280px; }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .55rem .85rem; border-bottom: 1px solid var(--line); background: var(--surface); font-size: .78rem; color: var(--muted); }
    .bar strong { color: var(--ink); font-weight: 600; }
    .connecting { margin: 0; opacity: 1; transition: opacity .35s ease; }
    .connecting.is-clear { opacity: 0; }
    iframe { flex: 1; width: 100%; border: 0; background: #111; min-height: 0; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="bar">
      <strong>Live browser</strong>
      <p class="connecting" id="connecting" role="status">Connecting…</p>
    </div>
    <iframe
      id="live-frame"
      title="Remote live browser"
      src="${escapeAttr(options.frameUrl)}"
      allow="clipboard-read; clipboard-write"
      referrerpolicy="no-referrer"
    ></iframe>
  </div>
  <script>
    (function () {
      var el = document.getElementById("connecting");
      var frame = document.getElementById("live-frame");
      function clearStatus() {
        if (!el) return;
        el.classList.add("is-clear");
        el.setAttribute("aria-hidden", "true");
        window.setTimeout(function () { el.textContent = ""; }, 400);
      }
      if (frame) frame.addEventListener("load", clearStatus);
      window.setTimeout(clearStatus, 2500);
    })();
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(status: number, title: string, bodyHtml: string, options?: { embed?: boolean }) {
  const compact = Boolean(options?.embed);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="robots" content="noindex"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)} · JobAppAgent</title>
  <style>
    :root { color-scheme: light; --ink: #1a1a1a; --muted: #5c5c5c; --line: #e4e0d8; --bg: #f7f4ef; --panel: #fff; }
    body { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; background: var(--bg); color: var(--ink); }
    main { max-width: ${compact ? "100%" : "40rem"}; margin: 0 auto; padding: ${compact ? "1rem 1rem 1.5rem" : "2.5rem 1.25rem 4rem"}; }
    a { color: #0b3d2e; }
    h1 { font-size: ${compact ? "1.25rem" : "1.65rem"}; line-height: 1.2; margin: 0.35rem 0 1rem; }
    .eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; color: var(--muted); }
    .panel { background: var(--panel); border: 1px solid var(--line); padding: 1.25rem 1.35rem; border-radius: 2px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    .legal-back { display: ${compact ? "none" : "inline-block"}; margin-bottom: 1.5rem; text-decoration: none; color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <a class="legal-back" href="/">← JobAppAgent</a>
    <section class="panel">
      <p class="eyebrow">Attention · live session</p>
      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
    </section>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
