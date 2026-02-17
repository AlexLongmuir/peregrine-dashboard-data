# Scope triage

- Updated: 2026-02-17T09:40:47.596Z

```json
{
  "decision": "split",
  "rationale": "This PRD mixes a pixel-perfect UI rebuild (HTML/CSS/icons/states) with behavioral requirements (routing fallbacks, offline handling, fatal render error banner) and telemetry. Splitting into sequential packages reduces risk: first lock the visual/footer component and responsiveness, then add naviga

[REDACTED]
