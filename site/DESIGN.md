# Quiet Trust design system

JobAppAgent should feel calm, inspectable, and quietly capable—not like a gamified job board or a hustle product. The experience reduces cognitive load while keeping agency and evidence visible.

## Brand foundations (theme B, site-wide)

- One palette for every public route, defined once in `app/globals.css` `:root` (`/jobs` reads the same tokens).
- White base `#FFFFFF`, panels `#F8FAFC`, hairlines `#E2E8F0`, control borders `#8492A6`.
- Ink `#0F172A` for headings, body `#334155`, muted `#5B6B80`.
- Electric blue `#2563EB` for primary actions and focus rings (hover `#1D4ED8`, links `#1D4ED8`, soft `#EFF5FF`).
- Green `#065F46` on `#ECFDF5` only for "free", "done" and verified states. Coral `#B42318` is reserved for pauses, errors, and human-only decisions.
- **Libre Baskerville** carries H1/H2 headings. **DM Sans** carries body copy, navigation, labels, and controls. **IBM Plex Mono** is only for CLI commands, prompts, and code.

## Composition

- White pages with flat panel cards (12px radius, 1px hairline), pill buttons (48px primary, 44px small), one primary action per section.
- The founding offer is the only ink (dark) block on the homepage.
- Avoid decorative shadows, gradients, dashboard gloss, robots, sparkles, and stock job-board imagery.
- Motion is subtle and always respects reduced-motion preferences. Focus: 3px blue outline, 2px offset.
- Layouts hold at 375, 768, and 1440 wide.

## Homepage structure

Free first, paid next: hero with the three-step path (open-source agent → job board → Cloud), lifetime community counters, "Available now" (agent install + job board), how it works and boundaries, then the Cloud founding reservation (offer, available now vs coming with Cloud, launch status, dateless progress, founder note), then FAQ. The paid $49 reservation is the Cloud interest capture; there is no free waitlist.

## Mark

The boundary-run mark is intentionally limited to three shapes: a parchment tile, a forest route, and an eucalyptus endpoint. It represents routine work moving within a clear boundary. It must stay legible at 16px and remain recognizable in monochrome. Use the same mark for favicon, installable app icon, header, and social identity.

## Voice and evidence

- Calm, direct, specific, and never breathless. Avoid hustle language, artificial urgency, or growth hype.
- Show evidence as receipts, thresholds, and run states. Never present illustrative numbers as real customer results.
- Lead cloud conversion with verified aggregate community proof. Label installations as installations, never as people.
- Keep the public journey focused on the hosted product; open-source provenance may remain in supporting copy without competing calls to action.
- Use this same system across `jobappagent.com` and `stats.jobappagent.com`.
- Lead with what is free and available now; Cloud is the next step, never a date.

## Locked hosted buyer flow

The Vaibhav/CoS-locked local `jaa-full-flow-gstack` design-html and shots define the
hosted Preflight → Choose → Queue → Judgment → Done flow. Its scoped product
extension uses Inter + Instrument Serif, `#F7F4EF` background, `#1B3D2F` ink, and
`#2F6B5A` primary. Buyer attention is only for employer questions; technical issues
stay in progress and take a separate ops path. See [ATTENTION.md](docs/ATTENTION.md)
for fixture URLs, auth boundaries, and explicit backend/notification stubs.
