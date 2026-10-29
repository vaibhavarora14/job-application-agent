"use client";

import { useState, type ReactNode } from "react";

/**
 * Clipboard button. `copiedLabel` replaces the label for 1.6 s after a copy; the
 * optional `copiedNote` is announced politely (and shown where the caller styles it).
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
  icon,
  ariaLabel,
  noteClassName,
  copiedNote,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  icon?: ReactNode;
  ariaLabel?: string;
  noteClassName?: string;
  copiedNote?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={ariaLabel}
        data-copied={copied ? "true" : undefined}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          } catch {
            /* clipboard blocked: the prompt stays readable in "Preview the prompt" */
          }
        }}
      >
        {icon}
        {ariaLabel ? null : copied ? copiedLabel : label}
      </button>
      {copiedNote ? (
        <span className={noteClassName} role="status" aria-live="polite">
          {copied ? copiedNote : ""}
        </span>
      ) : null}
    </>
  );
}
