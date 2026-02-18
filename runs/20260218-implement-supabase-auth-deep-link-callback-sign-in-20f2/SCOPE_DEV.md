# Scope triage

- Updated: 2026-02-18T18:55:30.776Z

```json
{
  "decision": "split",
  "rationale": "Auth touches app startup/root routing, secure-ish configuration, session persistence, deep link plumbing, and Apple sign-in UI. Splitting into 3 sequential packages reduces integration risk and makes each step independently verifiable (build/config + session restore/token API first, then URL callb

[REDACTED]
