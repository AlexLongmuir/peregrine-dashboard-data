# Scope triage

- Updated: 2026-02-17T09:06:09.745Z

```json
{
  "decision": "split",
  "rationale": "This touches multiple concerns (pixel-perfect UI/CSS parity, navigation/link mapping with fallbacks, offline/error handling, telemetry, and tests). Splitting into sequential packages reduces risk and makes each step independently verifiable (visual parity first, then behavior/telemetry, then robus

[REDACTED]
