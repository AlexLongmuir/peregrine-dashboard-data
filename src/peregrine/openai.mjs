/**
 * OpenAI helpers for PRD/Dev/Review.
 */

import OpenAI from "openai";
import { requireEnv } from "./util.mjs";

function client() {
  return new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
}

function model(name, fallback) {
  return process.env[name] || fallback;
}

export async function rewritePrdFromIntake({ title, roughDraft, targetRepo }) {
  const openai = client();
  const m = model("OPENAI_MODEL_PRD", "gpt-4.1");

  const system = `You are a senior product manager and tech lead. Convert messy intake into a crisp GitHub-issue PRD that is READY TO IMPLEMENT without requiring further input.

Output MUST be valid JSON with keys: title, body.
The body MUST be Markdown and include sections exactly in this order:
1. Original intake (verbatim)
2. Revised PRD
   - Problem / context
   - Goals
   - Non-goals
   - UX / UI notes (include loading/empty/error/offline states)
   - Acceptance Criteria (AC1, AC2, ...)
   - Telemetry (Mixpanel) (only if relevant)
   - RevenueCat impact (only if relevant)
   - Backend/API notes (only if relevant)
   - Supabase notes (schema/RLS/functions/migrations) (only if relevant)
   - Test expectations
   - Open questions

Rules:
- Do NOT leave placeholders like "to be confirmed", "TBD", or "exact wording to be confirmed".
- If the intake is missing specifics, make reasonable best-guess assumptions and CHOOSE exact values so the dev bot can implement immediately.
  - Example: for copy/text changes, propose the exact final string(s) to use.
- Acceptance Criteria MUST be objectively checkable and include any exact strings, numbers, or behaviors needed to implement.
- Keep Open questions to a minimum. Only include items that truly require a human business decision; otherwise decide.
- Do not invent nonexistent endpoints/services. If backend details are unknown, constrain scope to UI-only or clearly specify what to create.`;

  const user = `Target repo: ${targetRepo}\n\nIntake title: ${title}\n\nIntake rough draft (verbatim):\n${roughDraft}`;

  const res = await openai.chat.completions.create({
    model: m,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = res.choices?.[0]?.message?.content ?? "{}";
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PRD agent returned non-JSON: ${text.slice(0, 300)}`);
  }

  if (!json.title || !json.body) throw new Error(`PRD agent missing fields: ${text.slice(0, 300)}`);
  return { title: String(json.title), body: String(json.body) };
}

export async function planDev({ prdBody }) {
  const openai = client();
  const m = model("OPENAI_MODEL_DEV", "gpt-4.1");

  const system = `You are a senior engineer. Produce a concise implementation plan for the PRD.
Output MUST be Markdown with sections:
- Summary
- Steps
- Files to touch (guesses allowed)
- Risks
- Test plan
- AC mapping (ACx -> how it's satisfied)`;

  const res = await openai.chat.completions.create({
    model: m,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prdBody },
    ],
  });

  return res.choices?.[0]?.message?.content ?? "";
}

export async function reviewAgainstPrd({ prdBody, prDiffSummary, prBody }) {
  const openai = client();
  const m = model("OPENAI_MODEL_REVIEW", "gpt-4.1");

  const system = `You are a strict reviewer. Review implementation against the PRD and acceptance criteria.
Output MUST be Markdown with:
- Verdict: PASS or FAIL
- AC checklist: AC1.. each Pass/Fail + evidence needed
- Key issues (if any)
- Suggested fixes (actionable)
Do not nitpick style unless it affects correctness/safety.`;

  const user = `PRD:\n${prdBody}\n\nPR description:\n${prBody}\n\nDiff summary:\n${prDiffSummary}`;

  const res = await openai.chat.completions.create({
    model: m,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return res.choices?.[0]?.message?.content ?? "";
}
