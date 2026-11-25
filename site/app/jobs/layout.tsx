import type { ReactNode } from "react";
import { JobsAnalytics } from "./JobsAnalytics";

/**
 * Jobs surfaces keep the landing-client skip (JobsAnalyticsGate) so founding
 * `$pageview` does not start sending board query strings. JobsAnalytics sends
 * a separate personless /jobs capture. Shared chrome uses foundingCta={false}.
 */
export default function JobsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <JobsAnalyticsGate />
      <JobsAnalytics />
      {children}
    </>
  );
}

function JobsAnalyticsGate() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `window.__JAA_JOBS_NO_ANALYTICS__=1;`,
      }}
    />
  );
}
