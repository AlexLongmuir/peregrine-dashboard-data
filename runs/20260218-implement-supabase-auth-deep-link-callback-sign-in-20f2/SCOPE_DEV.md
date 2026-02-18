# Scope triage

- Updated: 2026-02-18T20:26:04.398Z

```json
{
  "decision": "split",
  "rationale": "Auth touches app startup, configuration, persistence, deep linking, and Apple sign-in UI. Splitting into 3 sequential packages reduces integration risk and makes each step independently verifiable (build/config + session restore/token API first, then URL routing, then Apple sign-in + UI state). Th

[REDACTED]
