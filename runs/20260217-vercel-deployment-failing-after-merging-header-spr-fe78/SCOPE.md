# Scope triage

- Updated: 2026-02-17T09:05:23.194Z

```json
{
  "decision": "split",
  "rationale": "We don’t have the actual failing stack trace yet, and Vercel/Next build failures after a merge can come from multiple independent causes (TypeScript, lint, missing env vars, SSR/Edge runtime issues, module resolution). Splitting into a quick “reproduce + capture + classify” package and a follow-up

[REDACTED]
