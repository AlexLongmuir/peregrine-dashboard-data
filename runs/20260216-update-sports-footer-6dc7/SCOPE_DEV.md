# Scope triage

- Updated: 2026-02-17T09:35:46.067Z

```json
{
  "decision": "split",
  "rationale": "This touches multiple independently testable concerns (pixel-perfect UI/CSS parity, navigation/link behavior with offline/coming-soon fallbacks, and telemetry + error handling + tests). Splitting into sequential packages reduces risk of regressions and makes verification clearer while still landin

[REDACTED]
