# Scope triage

- Updated: 2026-02-18T18:03:12.489Z

```json
{
  "decision": "split",
  "rationale": "This spans three distinct concerns (Supabase SDK/session persistence, deep-link auth callback plumbing, and Sign in with Apple UI/flow). Splitting keeps each step independently testable and reduces integration risk while still landing in one PR/branch.",
  "packages": [
    {
      "name": "Supaba

[REDACTED]
