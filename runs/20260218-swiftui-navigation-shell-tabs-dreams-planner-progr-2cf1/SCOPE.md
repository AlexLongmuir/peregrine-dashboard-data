# Scope triage

- Updated: 2026-02-18T18:04:08.580Z

```json
{
  "decision": "split",
  "rationale": "This touches three concerns that are easiest to verify independently: (1) the SwiftUI tab + per-tab NavigationStack shell, (2) placeholder screens and navigation wiring inside each stack, and (3) deep link routing into the correct tab/stack. Splitting reduces risk of getting blocked on deep link d

[REDACTED]
