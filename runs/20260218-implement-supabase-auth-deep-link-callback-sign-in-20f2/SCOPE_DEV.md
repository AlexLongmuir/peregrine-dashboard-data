# Scope triage

- Updated: 2026-02-21T20:42:57.632Z

```json
{
  "decision": "split",
  "rationale": "Auth spans SDK/config bootstrapping, session lifecycle/token API, URL-scheme deep link plumbing, and UI + Sign in with Apple. Splitting into 3 sequential packages reduces integration risk (especially around redirect handling + Apple flow), keeps each step independently verifiable, and aligns with 

[REDACTED]
