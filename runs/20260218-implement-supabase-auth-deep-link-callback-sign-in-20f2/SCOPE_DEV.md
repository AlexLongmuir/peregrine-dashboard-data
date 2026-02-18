# Scope triage

- Updated: 2026-02-18T21:18:36.365Z

```json
{
  "decision": "split",
  "rationale": "Auth touches app startup, configuration, persistence, deep linking, and Apple sign-in UI. Splitting into 3 sequential packages reduces integration risk and makes each step independently verifiable (build/config + session restore + token API; then URL routing; then Apple sign-in + UI state), while 

[REDACTED]
