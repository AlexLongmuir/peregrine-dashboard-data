# Scope triage

- Updated: 2026-02-18T18:49:57.281Z

```json
{
  "decision": "split",
  "rationale": "Auth touches app startup, configuration, persistence, URL routing, and Apple sign-in UI. Splitting into 3 sequential packages reduces integration risk and makes each step independently verifiable (build/config + session restore/token API, then deep link completion, then Apple sign-in + UI state/si

[REDACTED]
