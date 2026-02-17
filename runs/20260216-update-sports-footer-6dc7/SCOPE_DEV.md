# Scope triage

- Updated: 2026-02-17T09:30:50.823Z

```json
{
  "decision": "split",
  "rationale": "This touches multiple concerns (pixel-perfect UI/CSS, navigation behavior + offline/coming-soon logic, telemetry, and testing/visual regression). Splitting into sequential packages keeps each step independently verifiable (visual parity first, then behavior/instrumentation, then hardening/tests) w

[REDACTED]
