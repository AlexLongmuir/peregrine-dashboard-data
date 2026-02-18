# Scope triage

- Updated: 2026-02-18T20:31:44.881Z

```json
{
  "decision": "split",
  "rationale": "This change bundles three distinct concerns that are best verified independently: (1) pixel-perfect UI replication (HTML/CSS/icons/states) with responsive + a11y requirements, (2) navigation behavior + offline/coming-soon handling, and (3) telemetry + fatal-render error handling + tests. Splitting

[REDACTED]
