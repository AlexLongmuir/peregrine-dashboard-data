# Scope triage

- Updated: 2026-02-18T19:13:31.072Z

```json
{
  "decision": "split",
  "rationale": "Auth touches app startup, secure-ish configuration, URL routing, and Apple sign-in UI. Splitting into 3 sequential packages reduces integration risk and makes each step independently verifiable (build/config + session restore/token API first, then deep link routing, then Apple sign-in + UI state).

[REDACTED]
