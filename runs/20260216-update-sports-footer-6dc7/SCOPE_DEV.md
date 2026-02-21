# Scope triage

- Updated: 2026-02-21T20:37:54.253Z

```json
{
  "decision": "split",
  "rationale": "This is mostly UI, but it has distinct, independently verifiable concerns: (1) pixel-perfect markup/CSS and responsive behavior, (2) navigation + offline/coming-soon/error handling, and (3) telemetry + tests/accessibility. Splitting reduces risk of regressions and makes review/verification straigh

[REDACTED]
