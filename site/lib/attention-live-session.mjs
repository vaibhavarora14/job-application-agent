/**
 * Auth’d live-session redirect for attention / noVNC.
 *
 * Magic-link users never receive the raw VNC password in email.
 * The site Worker verifies the attention magic token, then 302s to noVNC
 * with optional short-lived credentials in the URL fragment (not query),
 * so the password is not sent to the HTTP server or access logs.
 *
 * Full WebSocket proxy is out of scope; IAP tunnel docs cover private agent-box.
 */

/**
 * @param {string} baseUrl
 * @param {{ attentionId?: string, password?: string, autoconnect?: boolean }} [options]
 */
export function buildNoVncLiveSessionUrl(baseUrl, options = {}) {
  const raw = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!raw) return { ok: false, error: "live_session_base_unconfigured" };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "live_session_base_invalid" };
  }

  const attentionId = typeof options.attentionId === "string" ? options.attentionId.trim() : "";
  if (attentionId && !url.searchParams.has("attention")) {
    url.searchParams.set("attention", attentionId);
  }

  if (options.autoconnect !== false && !url.searchParams.has("autoconnect")) {
    url.searchParams.set("autoconnect", "true");
  }
  if (!url.searchParams.has("reconnect")) {
    url.searchParams.set("reconnect", "true");
  }

  const password = typeof options.password === "string" ? options.password : "";
  // Prefer fragment so the VNC password is not logged by intermediaries.
  if (password) {
    const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    fragment.set("password", password);
    url.hash = fragment.toString();
  }

  return { ok: true, url: url.toString(), hasPassword: Boolean(password) };
}

/**
 * Resolve where "Open live session" should send an authenticated candidate.
 *
 * @param {{
 *   liveSessionBaseUrl?: string,
 *   novncPassword?: string,
 *   iapHelperCommand?: string,
 * }} config
 * @param {string} attentionId
 */
export function resolveLiveSessionTarget(config, attentionId) {
  const baseUrl = typeof config?.liveSessionBaseUrl === "string" ? config.liveSessionBaseUrl.trim() : "";
  const password = typeof config?.novncPassword === "string" ? config.novncPassword : "";
  const id = typeof attentionId === "string" ? attentionId.trim() : "";

  if (baseUrl) {
    const built = buildNoVncLiveSessionUrl(baseUrl, {
      attentionId: id,
      password,
      autoconnect: true,
    });
    if (!built.ok) return { mode: "error", error: built.error };
    return {
      mode: "redirect",
      url: built.url,
      hasPassword: built.hasPassword,
      note: built.hasPassword
        ? "Redirect includes one-time credentials in the URL fragment; never email this URL."
        : "Redirect without Worker-injected password; noVNC may prompt locally.",
    };
  }

  const iapHelper = typeof config?.iapHelperCommand === "string" && config.iapHelperCommand.trim()
    ? config.iapHelperCommand.trim()
    : defaultIapHelperCommand();

  return {
    mode: "iap",
    attentionId: id || null,
    iapHelperCommand: iapHelper,
    localUrl: "http://127.0.0.1:6080/vnc.html?autoconnect=true",
    note: "ATTENTION_LIVE_SESSION_BASE_URL unset — use IAP tunnel to agent-box port 6080, then open local noVNC.",
  };
}

/**
 * Default founder helper for GCP agent-box (port 6080 historically hosts noVNC).
 * Replace INSTANCE / ZONE / PROJECT via ATTENTION_IAP_HELPER_COMMAND when set.
 */
export function defaultIapHelperCommand() {
  return [
    "gcloud compute start-iap-tunnel AGENT_BOX_INSTANCE 6080",
    "--local-host-port=localhost:6080",
    "--zone=AGENT_BOX_ZONE",
    "--project=AGENT_BOX_PROJECT",
  ].join(" ");
}

/**
 * Site-relative live-session path (Worker verifies magic token, then redirects).
 * @param {string} attentionId
 * @param {string} magicToken
 */
export function buildLiveSessionProxyPath(attentionId, magicToken) {
  const id = encodeURIComponent(String(attentionId ?? "").trim());
  const url = new URL(`https://placeholder.local/api/attention/${id}/live-session`);
  url.searchParams.set("token", String(magicToken ?? "").trim());
  return `${url.pathname}${url.search}`;
}

/**
 * Absolute live-session proxy URL on the public site.
 * @param {string} publicSiteUrl
 * @param {string} attentionId
 * @param {string} magicToken
 */
export function buildLiveSessionProxyUrl(publicSiteUrl, attentionId, magicToken) {
  const origin = new URL(publicSiteUrl).origin;
  const path = buildLiveSessionProxyPath(attentionId, magicToken);
  return new URL(path, origin).toString();
}
