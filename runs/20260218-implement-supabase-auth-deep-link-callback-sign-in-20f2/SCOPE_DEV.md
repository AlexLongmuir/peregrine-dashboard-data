# Scope triage

- Updated: 2026-02-18T18:28:39.461Z

```json
{
  "decision": "split",
  "rationale": "Auth spans SDK/config bootstrapping, session lifecycle/token API, URL/deep-link callback plumbing, and UI + Sign in with Apple. Splitting into 3 sequential packages reduces integration risk (especially deep link + Apple auth), keeps each step independently verifiable, and matches the PRD’s own wor

[REDACTED]
