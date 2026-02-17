# Scope triage

- Updated: 2026-02-17T09:12:03.088Z

```json
{
  "decision": "split",
  "rationale": "This PRD mixes a pixel-perfect UI rebuild (HTML/CSS/icons/states) with behavioral requirements (routing fallbacks, offline handling, fatal render error banner) and telemetry plus tests. Splitting into sequential packages reduces risk: first lock the visual/footer component, then add navigation/off

[REDACTED]
