/**
 * PostHog `$web_vitals` from `web-vitals` (no posthog-js). LCP, CLS, INP only.
 * Observers are injected so this module stays free of the npm import (root `npm test`
 * does not install site dependencies).
 */

import { captureLandingEvent } from "./landing-analytics.mjs";

export const WEB_VITALS_FLUSH_MS = 5000;
export const WEB_VITALS_MAX_MS = 15 * 60 * 1000;
const WEB_VITAL_NAMES = Object.freeze(["LCP", "CLS", "INP"]);

/**
 * @param {{ name?: string, value?: number }} metric
 */
function isAllowedMetric(metric) {
  if (!metric || typeof metric.name !== "string" || typeof metric.value !== "number") return false;
  if (!WEB_VITAL_NAMES.includes(metric.name)) return false;
  if (metric.name !== "CLS" && metric.value >= WEB_VITALS_MAX_MS) return false;
  return true;
}

/**
 * PostHog web vitals feature reads `$web_vitals_<NAME>_value` and `_event`.
 * @param {Array<{ name: string, value: number, rating?: string, delta?: number, id?: string, navigationType?: string }>} metrics
 */
export function webVitalsToPostHogProperties(metrics) {
  /** @type {Record<string, unknown>} */
  const properties = {};
  for (const metric of metrics) {
    if (!isAllowedMetric(metric)) continue;
    properties[`$web_vitals_${metric.name}_value`] = metric.value;
    properties[`$web_vitals_${metric.name}_event`] = {
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      delta: metric.delta,
      id: metric.id,
      navigationType: metric.navigationType,
    };
  }
  return properties;
}

/**
 * @param {{
 *   apiKey: string,
 *   host?: string,
 *   pathname?: string,
 *   href?: string,
 *   fetchFn?: typeof fetch,
 *   sendBeacon?: (url: string, data: Blob) => boolean,
 *   pageHost?: string,
 *   sessionStore?: { getItem(key: string): string | null, setItem(key: string, value: string): void } | null,
 *   flushMs?: number,
 *   now?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} input
 * @param {{
 *   onLCP?: (cb: (metric: { name: string, value: number }) => void) => void,
 *   onCLS?: (cb: (metric: { name: string, value: number }) => void) => void,
 *   onINP?: (cb: (metric: { name: string, value: number }) => void) => void,
 * }} observers
 */
export function bindLandingWebVitals(input, observers = {}) {
  /** @type {Map<string, { name: string, value: number, rating?: string, delta?: number, id?: string, navigationType?: string }>} */
  const buffer = new Map();
  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  const scheduleFlush = () => {
    if (timer !== undefined) return;
    timer = setTimeoutFn(() => flush(false), input.flushMs ?? WEB_VITALS_FLUSH_MS);
  };

  const flush = (useBeacon) => {
    if (buffer.size === 0) return;
    const metrics = [...buffer.values()];
    buffer.clear();
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
    const pathname = input.pathname
      ?? (typeof window !== "undefined" ? window.location.pathname : "/");
    const href = input.href
      ?? (typeof window !== "undefined" ? window.location.href : pathname);
    void captureLandingEvent({
      apiKey: input.apiKey,
      host: input.host,
      event: "$web_vitals",
      properties: {
        $current_url: href,
        $pathname: pathname,
        ...webVitalsToPostHogProperties(metrics),
      },
      fetchFn: input.fetchFn,
      sendBeacon: input.sendBeacon,
      transport: useBeacon ? "beacon" : "fetch",
      pageHost: input.pageHost,
      sessionStore: input.sessionStore,
    });
  };

  const onMetric = (metric) => {
    if (!isAllowedMetric(metric)) return;
    buffer.set(metric.name, metric);
    if (buffer.size === WEB_VITAL_NAMES.length) {
      flush(false);
      return;
    }
    scheduleFlush();
  };

  observers.onLCP?.(onMetric);
  observers.onCLS?.(onMetric);
  observers.onINP?.(onMetric);
  scheduleFlush();

  const onHidden = () => flush(true);
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") onHidden();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onHidden);
  }

  return () => {
    if (timer !== undefined) clearTimeoutFn(timer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", onHidden);
    }
  };
}
