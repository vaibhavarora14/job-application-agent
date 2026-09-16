# agent-box — fill display + live noVNC binding

Hosted fill and the buyer live panel **must share one session**.

| Piece | Value | Notes |
|-------|-------|--------|
| Fill display | `DISPLAY=:99` | Xvfb headed Chrome |
| Fill VNC | x11vnc → **`localhost:5900`** | Mirrors `:99` |
| Live HTTP front | noVNC / websockify historically **`:6080`** | Buyer iframe / magic-link target |
| Forbidden | TigerVNC **`:1` / `5901`** | Cold XFCE / wrong desktop = product failure |

## Hard rule

**Live noVNC = fill display 5900.**  
`websockify` must proxy `localhost:5900`. Never point buyer live at `5901`.

Verify on the box:

```bash
node job-application-agent/scripts/novnc-display-guard.mjs --unit /etc/systemd/system/novnc.service
# or:
node job-application-agent/scripts/novnc-display-guard.mjs --text "$(systemctl cat novnc.service)"
```

Example unit: [`novnc.service.example`](./novnc.service.example).

## Session binding (pause)

When attention opens on a filled form, record a **local-only** binding:

```bash
# Prefer optional fields on attention add (not synced to cloud):
node scripts/job-application.mjs attention add --stdin <<'JSON'
{
  "roundId": "round-…",
  "applicationId": "app-…",
  "url": "https://jobs.ashbyhq.com/…/application",
  "stage": "submission",
  "blocker": "captcha",
  "requiredActions": ["complete-captcha"],
  "browserProfilePath": "/home/runner/.jaa-chrome-fill",
  "display": ":99",
  "vncPort": 5900,
  "tabHint": { "urlContains": "/application" }
}
JSON

# Or write explicitly:
node scripts/session-binding.mjs write --stdin <<'JSON'
{
  "attentionId": "attention-…",
  "jobUrl": "https://jobs.ashbyhq.com/…/application",
  "browserProfilePath": "/home/runner/.jaa-chrome-fill",
  "display": ":99",
  "vncPort": 5900
}
JSON
```

Keep Chrome on that **exact filled tab** (same user-data-dir / CDP). Do not wipe the profile mid-pause. Do not navigate to a jobs listing.

## Resume → submit

After `attention-runner-poll.mjs` exit `0`:

```bash
node scripts/attention-resume-submit.mjs --checklist
node scripts/attention-resume-submit.mjs --attention-id attention-… --stdin <<'JSON'
{
  "pageUrl": "https://jobs.ashbyhq.com/…/application",
  "submitEnabled": true,
  "leaseHeld": true
}
JSON
```

Submit if the DOM is clear; ledger only after a **visible** ATS confirmation.
