"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  LEVEL_OPTIONS,
  PAY_OPTIONS,
  POSTED_OPTIONS,
  ROLE_OPTIONS,
  WORKPLACE_OPTIONS,
  activeFilterChips,
  activeFilterCount,
  boardHref,
  boardQueryString,
  emptyBoardQuery,
} from "../../lib/jobs-board-query.mjs";
import { JobRowSkeleton } from "./JobRowSkeleton";
import styles from "./jobs.module.css";

type BoardQuery = ReturnType<typeof emptyBoardQuery>;

/** Skeleton only after this long, so quick filter changes keep the current list. */
const SKELETON_DELAY_MS = 800;
/** A navigation that has not answered by now shows the error state. */
const STALL_MS = 15000;

function Check() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.tgIcon}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} className={`${styles.tg}${on ? ` ${styles.tgOn}` : ""}`} onClick={onClick}>
      {on ? <Check /> : null}
      {children}
    </button>
  );
}

function toggleIn(list: string[], value: string) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function FilterFields({
  value,
  onChange,
  idPrefix,
  debounceLocation,
}: {
  value: BoardQuery;
  onChange: (next: BoardQuery) => void;
  idPrefix: string;
  debounceLocation: boolean;
}) {
  const [loc, setLoc] = useState(value.loc);
  const [syncedLoc, setSyncedLoc] = useState(value.loc);
  const timer = useRef<number | null>(null);
  if (syncedLoc !== value.loc) {
    setSyncedLoc(value.loc);
    setLoc(value.loc);
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const set = (patch: Partial<BoardQuery>) => onChange({ ...value, show: 50, ...patch });

  const commitLoc = (next: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    if (next.trim() === value.loc) return;
    set({ loc: next.trim() });
  };

  return (
    <>
      <fieldset className={styles.fg}>
        <legend>Workplace</legend>
        <div className={`${styles.tgs} ${styles.c3}`}>
          {WORKPLACE_OPTIONS.map((o) => (
            <Toggle key={o.value} on={value.workplace.includes(o.value)} onClick={() => set({ workplace: toggleIn(value.workplace, o.value) })}>
              {o.label}
            </Toggle>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.fg}>
        <legend>Location</legend>
        <label className={styles.field} htmlFor={`${idPrefix}-loc`}>
          <span className={styles.sr}>Country or region</span>
          <input
            id={`${idPrefix}-loc`}
            type="search"
            placeholder="Country or region"
            value={loc}
            autoComplete="off"
            onChange={(event) => {
              const next = event.target.value;
              setLoc(next);
              if (!debounceLocation) {
                onChange({ ...value, show: 50, loc: next.trim() });
                return;
              }
              if (timer.current) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => commitLoc(next), 450);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitLoc(loc);
              }
            }}
            onBlur={() => debounceLocation && commitLoc(loc)}
          />
        </label>
      </fieldset>
      <fieldset className={styles.fg}>
        <legend>Minimum pay, per year</legend>
        <div className={`${styles.tgs} ${styles.c2}`}>
          {PAY_OPTIONS.map((o) => (
            <Toggle key={o.value} on={value.pay === o.value} onClick={() => set({ pay: o.value })}>
              {o.label}
            </Toggle>
          ))}
        </div>
        <div className={styles.swRow}>
          <span id={`${idPrefix}-nopay`}>Include roles without listed pay</span>
          <button
            type="button"
            role="switch"
            aria-checked={value.nopay}
            aria-labelledby={`${idPrefix}-nopay`}
            className={`${styles.sw}${value.nopay ? ` ${styles.swOn}` : ""}`}
            onClick={() => set({ nopay: !value.nopay })}
          >
            <i />
          </button>
        </div>
        <p className={styles.hint}>Compared in USD at monthly exchange rates.</p>
      </fieldset>
      <fieldset className={styles.fg}>
        <legend>Seniority</legend>
        <div className={`${styles.tgs} ${styles.c3}`}>
          {LEVEL_OPTIONS.map((o) => (
            <Toggle key={o.value} on={value.level.includes(o.value)} onClick={() => set({ level: toggleIn(value.level, o.value) })}>
              {o.label}
            </Toggle>
          ))}
        </div>
        <p className={styles.hint}>Only roles where the employer states a level.</p>
      </fieldset>
      <fieldset className={styles.fg}>
        <legend>Posted</legend>
        <div className={`${styles.tgs} ${styles.c2}`}>
          {POSTED_OPTIONS.map((o) => (
            <Toggle key={o.value} on={value.posted === o.value} onClick={() => set({ posted: o.value })}>
              {o.label}
            </Toggle>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.fg}>
        <legend>Role</legend>
        <div className={styles.tgs}>
          {ROLE_OPTIONS.map((role) => (
            <Toggle key={role} on={value.role.includes(role)} onClick={() => set({ role: toggleIn(value.role, role) })}>
              {role}
            </Toggle>
          ))}
        </div>
      </fieldset>
    </>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.btnIcon}>
      <path d="M3 5.5h14M5.5 10h9M8 14.5h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.btnIcon}>
      <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function useMatchCount(query: BoardQuery, enabled: boolean) {
  const [result, setResult] = useState<{ key: string; count: number | null } | null>(null);
  const key = boardQueryString(query);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/jobs/count${key ? `?${key}` : ""}`, { signal: controller.signal });
        if (!response.ok) throw new Error("count");
        const body = (await response.json()) as { count?: number };
        setResult({ key, count: typeof body.count === "number" ? body.count : null });
      } catch {
        if (!controller.signal.aborted) setResult({ key, count: null });
      }
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [key, enabled]);
  // Only a count for exactly these filters; otherwise the button says "Show roles".
  return result && result.key === key ? result.count : null;
}

function FilterSheet({
  initial,
  matched,
  onApply,
  onClose,
}: {
  initial: BoardQuery;
  matched: number;
  onApply: (next: BoardQuery) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<BoardQuery>(initial);
  const changed = boardQueryString(draft) !== boardQueryString(initial);
  const fetched = useMatchCount(draft, changed);
  const count = changed ? fetched : matched;
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !sheetRef.current) return;
      const focusables = sheetRef.current.querySelectorAll<HTMLElement>("button, input, a[href]");
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const label = count == null ? "Show roles" : `Show ${count} role${count === 1 ? "" : "s"}`;

  return (
    <div className={styles.sheetLayer}>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="jobs-filter-title"
      >
        <div
          className={styles.sheetTop}
          onTouchStart={(event) => { dragStart.current = event.touches[0]?.clientY ?? null; }}
          onTouchEnd={(event) => {
            const start = dragStart.current;
            dragStart.current = null;
            const end = event.changedTouches[0]?.clientY;
            if (start != null && end != null && end - start > 60) onClose();
          }}
        >
          <div className={styles.grab} aria-hidden="true" />
          <div className={styles.shHead}>
            <h2 id="jobs-filter-title">Filters</h2>
            {activeFilterCount(draft) > 0 ? (
              <button type="button" className={styles.link} onClick={() => setDraft(emptyBoardQuery())}>
                Clear all
              </button>
            ) : null}
            <button ref={closeRef} type="button" className={styles.iconBtn} aria-label="Close filters" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className={styles.shBody}>
          <FilterFields value={draft} onChange={setDraft} idPrefix="sheet" debounceLocation={false} />
        </div>
        <div className={styles.shFoot}>
          <button type="button" className={`${styles.btn} ${styles.pri} ${styles.full}`} onClick={() => onApply(draft)}>
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BoardFrame({
  query,
  total,
  matched,
  failed,
  children,
}: {
  query: BoardQuery;
  total: number;
  matched: number;
  failed: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [phase, setPhase] = useState<"idle" | "skeleton" | "stalled">("idle");
  const filterButton = useRef<HTMLButtonElement>(null);
  const pendingApply = useRef<BoardQuery | null>(null);
  const queryKey = boardQueryString(query, { keepShow: true, keepDesign: true });
  const forcedLoading = query.design === "loading";

  // New server render arrived for the requested filters: drop pending UI.
  const [renderedKey, setRenderedKey] = useState(queryKey);
  if (renderedKey !== queryKey) {
    setRenderedKey(queryKey);
    setPendingSince(null);
    setPhase("idle");
  }

  useEffect(() => {
    if (pendingSince == null) return;
    const skeleton = window.setTimeout(() => setPhase("skeleton"), SKELETON_DELAY_MS);
    const stall = window.setTimeout(() => setPhase("stalled"), STALL_MS);
    return () => {
      window.clearTimeout(skeleton);
      window.clearTimeout(stall);
    };
  }, [pendingSince]);

  const navigate = useCallback((next: BoardQuery) => {
    const href = boardHref(next, { keepShow: true });
    const current = boardHref(query, { keepShow: true });
    if (href === current) return;
    setPendingSince(Date.now());
    router.push(href, { scroll: false });
  }, [query, router]);

  const closeSheet = useCallback(() => {
    if (typeof window !== "undefined" && (window.history.state as { jaaSheet?: number } | null)?.jaaSheet) {
      window.history.back();
      return;
    }
    setSheetOpen(false);
    filterButton.current?.focus();
  }, []);

  // Back button closes the sheet: opening pushes a same-URL history entry.
  useEffect(() => {
    if (!sheetOpen) return;
    const onPop = () => {
      setSheetOpen(false);
      filterButton.current?.focus();
      const next = pendingApply.current;
      pendingApply.current = null;
      if (next) navigate(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [sheetOpen, navigate]);

  const openSheet = () => {
    window.history.pushState({ ...(window.history.state ?? {}), jaaSheet: 1 }, "", window.location.href);
    setSheetOpen(true);
  };

  const applySheet = (next: BoardQuery) => {
    if ((window.history.state as { jaaSheet?: number } | null)?.jaaSheet) {
      pendingApply.current = next;
      window.history.back();
      return;
    }
    setSheetOpen(false);
    filterButton.current?.focus();
    navigate(next);
  };

  const chips = useMemo(() => activeFilterChips(query), [query]);
  const badge = activeFilterCount(query);
  const showSkeleton = forcedLoading || phase === "skeleton";
  const stalled = phase === "stalled";

  let title: string;
  let sub: string;
  if (failed || stalled) {
    title = "Roles did not load";
    sub = "";
  } else if (showSkeleton) {
    title = "Updating roles";
    sub = chips.map((chip) => chip.label).join(", ");
  } else if (badge > 0) {
    title = `${matched} role${matched === 1 ? "" : "s"} match`;
    sub = `of ${total} open roles`;
  } else {
    title = `${total} open role${total === 1 ? "" : "s"}`;
    sub = "Newest posted first";
  }

  return (
    <div className={styles.board}>
      <aside className={styles.side} aria-label="Filters">
        <div className={styles.sideHead}>
          <h2>Filters</h2>
          {badge > 0 ? (
            <button type="button" className={styles.link} onClick={() => navigate(emptyBoardQuery())}>
              Clear all
            </button>
          ) : null}
        </div>
        <FilterFields value={query} onChange={navigate} idPrefix="side" debounceLocation />
      </aside>
      <section className={styles.results} aria-label="Open roles" aria-busy={showSkeleton}>
        <div className={styles.toolbar}>
          <p className={styles.count} role="status">
            <b>{title}</b>
            {sub ? <span>{sub}</span> : null}
          </p>
          {matched > 0 && !failed && !stalled ? (
            <div className={styles.cols} aria-hidden="true">
              <span>Location</span>
              <span>Workplace</span>
              <span className={styles.colR}>Pay</span>
              <span className={styles.colR}>Posted</span>
            </div>
          ) : null}
          <button
            ref={filterButton}
            type="button"
            className={`${styles.btnFilter}${badge ? ` ${styles.btnFilterOn}` : ""}`}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            onClick={openSheet}
          >
            <FilterIcon />
            Filters
            {badge ? <span className={styles.badge} aria-label={`${badge} active`}>{badge}</span> : null}
          </button>
        </div>
        {chips.length ? (
          <div className={styles.active}>
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className={styles.ac}
                aria-label={`Remove filter ${chip.label}`}
                onClick={() => navigate(chip.query)}
              >
                {chip.label}
                <CloseIcon />
              </button>
            ))}
            <button type="button" className={styles.clear} onClick={() => navigate(emptyBoardQuery())}>
              Clear all
            </button>
          </div>
        ) : null}
        {stalled ? (
          <div className={`${styles.empty} ${styles.err}`} role="alert">
            <p className={styles.eT}>We couldn&apos;t load the role list</p>
            <p className={styles.eB}>The request did not finish. Your filters are saved in the link.</p>
            <div className={styles.eA}>
              <button type="button" className={`${styles.btn} ${styles.pri}`} onClick={() => window.location.reload()}>
                Try again
              </button>
            </div>
          </div>
        ) : showSkeleton ? (
          <div className={styles.list} aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => <JobRowSkeleton key={i} />)}
          </div>
        ) : (
          <div className={pendingSince != null ? styles.dimmed : undefined}>{children}</div>
        )}
      </section>
      {sheetOpen ? (
        <FilterSheet initial={query} matched={matched} onApply={applySheet} onClose={closeSheet} />
      ) : null}
    </div>
  );
}
