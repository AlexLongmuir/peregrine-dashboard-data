# Scope triage

- Updated: 2026-02-17T18:07:52.608Z

```json
{
  "decision": "split",
  "rationale": "Header and footer parity likely touches shared components used across multiple screens; splitting into two sequential packages reduces regression risk and makes verification clearer (header changes can be validated independently before footer changes).",
  "packages": [
    {
      "name": "Header

[REDACTED]
