# Scope triage

- Updated: 2026-02-17T18:09:17.191Z

```json
{
  "decision": "split",
  "rationale": "This PRD mixes a pixel-perfect UI rebuild (HTML/CSS/icons/states) with behavioral requirements (routing fallbacks, offline handling, fatal render error banner) and telemetry. Splitting into sequential packages keeps each step independently verifiable (visual parity first, then navigation/offline/e

[REDACTED]
