"use client";

import { useState } from "react";
import styles from "./ContentPage.module.css";

/** Code block with a copy-to-clipboard button. */
export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return <div className={styles.codeBlock}>
    <pre className={styles.code}><code>{code}</code></pre>
    <button
      type="button"
      className={styles.copy}
      aria-label={`Copy command: ${code}`}
      onClick={() => {
        navigator.clipboard?.writeText(code).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }).catch(() => setCopied(false));
      }}
    >{copied ? "Copied" : "Copy"}</button>
  </div>;
}
