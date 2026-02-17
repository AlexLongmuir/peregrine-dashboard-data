/**
 * OpenAI helpers for PRD/Dev/Review.
 *
 * Note: Some models (notably *-codex) are not supported on the legacy
 * `v1/chat/completions` endpoint. We use the Responses API for all calls.
 */

import OpenAI from "openai";
import { requireEnv } from "./util.mjs";

function client() {
  return new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
}

function model(name, fallback) {
  return process.env[name] || fallback;
}

function parseJsonOrThrow(text, label) {
  const raw = text ?? "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned non-JSON: ${String(raw).slice(0, 300)}`);
  }
}

function toResponsesInput({ system, user }) {
  return [
    system
      ? {
          role: "system",
          content: [{ type: "input_text", text: system }],
        }
      : null,
    user
      ? {
          role: "user",
          content: [{ type: "input_text", text: user }],
        }
      : null,
  ].filter(Boolean);
}

async function responsesText({ model: m, system, user, temperature = undefined, json = false }) {
  const openai = client();

  const payload = {
    model: m,
    input: toResponsesInput({ system, user }),
    ...(json ? { text: { format: { type: "json_object" } } } : {}),
  };
  if (typeof temperature === "number") payload.temperature = temperature;

  const res = await openai.responses.create(payload);
  return res.output_text ?? "";
}

export async function scopeTriageFromIntake({ title, roughDraft, targetRepo, maxPackages = 10 }) {
  const m = model("OPENAI_MODEL_PRD", "gpt-4.1");

  const system = `You are a pragmatic tech lead.

Decide whether this work should be implemented as a SINGLE package or SPLIT into multiple sequential work packages (still one PR/branch).

Output MUST be valid JSON with keys:
- decision: "single" | "split"
- rationale: string
- packages: array

Each packages[i] MUST have keys:
- name: string (short)
- goal: string (one sentence)
- acceptance_criteria_subset: string[] (concrete, verifiable outcomes; 2-6 items)
- likely_files_areas: string[] (likely directories/files/subsystems; guesses allowed)
- deps: string[] (names of earlier packages this depends on)
- risk: string (short)

Rules:
- Max packages: ${maxPackages}. If more are possible, merge them.
- If decision="single", packages MUST contain exactly 1 item.
- Packages must be independently verifiable.
- Keep it practical; no fluff.`;

  const user = `Target repo: ${targetRepo}\n\nIntake title: ${title}\n\nIntake rough draft (verbatim):\n${roughDraft}`;

  const text = await responsesText({ model: m, system, user, temperature: 0.1, json: true });
  const json = parseJsonOrThrow(text, "Scope triage");

  return {
    decision: String(json.decision || ""),
    rationale: String(json.rationale || ""),
    packages: Array.isArray(json.packages) ? json.packages : [],
  };
}

export async function scopeTriageFromPrd({ prdBody, maxPackages = 10 }) {
  // Use PRD model (not dev/codex) because some codex models don't support sampling params.
  const m = model("OPENAI_MODEL_PRD", "gpt-4.1");

  const system = `You are a pragmatic tech lead.

Given a PRD, decide whether implementation should be executed as a SINGLE package or SPLIT into multiple sequential work packages (still one PR/branch).

Output MUST be valid JSON with keys:
- decision: "single" | "split"
- rationale: string
- packages: array

Each packages[i] MUST have keys:
- name: string (short)
- goal: string (one sentence)
- acceptance_criteria_subset: string[] (reference AC ids like "AC3" when possible, otherwise restate the criterion)
- likely_files_areas: string[] (directories/files/subsystems)
- deps: string[] (names of earlier packages this depends on)
- risk: string (short)

Rules:
- Max packages: ${maxPackages}. If more are possible, merge them.
- If decision="single", packages MUST contain exactly 1 item.
- Packages must be independently verifiable.
- Keep it practical; no fluff.`;

  const text = await responsesText({ model: m, system, user: prdBody, temperature: 0.1, json: true });
  const json = parseJsonOrThrow(text, "Scope triage");

  return {
    decision: String(json.decision || ""),
    rationale: String(json.rationale || ""),
    packages: Array.isArray(json.packages) ? json.packages : [],
  };
}

export async function rewritePrdFromIntake({ title, roughDraft, targetRepo, scope = null }) {
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
- Do not invent nonexistent endpoints/services. If backend details are unknown, constrain scope to UI-only or clearly specify what to create.

If scope triage is provided, include a short "Work packages" subsection under Revised PRD that lists each package (name + goal) in order.`;

  const scopeBlock = scope ? `\n\nScope triage JSON (best-effort):\n${JSON.stringify(scope).slice(0, 6000)}` : "";
  const user = `Target repo: ${targetRepo}\n\nIntake title: ${title}\n\nIntake rough draft (verbatim):\n${roughDraft}${scopeBlock}`;

  const text = await responsesText({ model: m, system, user, temperature: 0.2, json: true });
  const json = parseJsonOrThrow(text, "PRD agent");

  if (!json.title || !json.body) throw new Error(`PRD agent missing fields: ${text.slice(0, 300)}`);
  return { title: String(json.title), body: String(json.body) };
}

export async function planDev({ prdBody }) {
  // Use PRD model for planning to keep DEV model reserved for code edits.
  const m = model("OPENAI_MODEL_PRD", "gpt-4.1");

  const system = `You are a senior engineer. Produce a concise implementation plan for the PRD.
Output MUST be Markdown with sections:
- Summary
- Steps
- Files to touch (guesses allowed)
- Risks
- Test plan
- AC mapping (ACx -> how it's satisfied)`;

  return responsesText({ model: m, system, user: prdBody, temperature: 0.2, json: false });
}

export async function generateEdits({ prdBody, plan, allowedPaths, repoFiles, candidateFiles, previousError, workPackage = null }) {
  const m = model("OPENAI_MODEL_DEV", "gpt-4.1");

  const system = `You are a senior engineer. Implement the PRD by editing files.

Output MUST be valid JSON with this shape:
{
  "files": [
    {"path": "relative/path.tsx", "content": "<full new file content>"}
  ]
}

Hard requirements:
- Provide FULL new content for each file you change.
- Touch at most 5 files.
- You MUST choose each path from the ALLOWED_PATHS list provided by the user.
- Do NOT create new files.
- No binary files.
- Prefer minimal changes.
- If previousError is provided, fix that exact problem.

Do NOT include markdown fences. JSON only.`;

  const wp = workPackage ? `# Work package\n${JSON.stringify(workPackage).slice(0, 6000)}` : null;

  const user = [
    `# PRD\n\n${prdBody}`,
    `# Plan\n\n${plan}`,
    wp,
    allowedPaths?.length ? `# ALLOWED_PATHS (choose from these ONLY)\n${allowedPaths.join("\n")}` : null,
    `# Repo file list (partial)\n${(repoFiles || []).slice(0, 2000).join("\n")}`,
    candidateFiles ? `# Candidate file contents\n${candidateFiles}` : null,
    previousError ? `# Previous error\n${previousError}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Some codex models reject sampling params like temperature; omit them.
  const text = await responsesText({ model: m, system, user, temperature: undefined, json: true });
  const json = parseJsonOrThrow(text, "Dev agent");

  if (!Array.isArray(json.files)) throw new Error(`Dev agent JSON missing files[]: ${text.slice(0, 300)}`);
  return json;
}

export async function reviewAgainstPrd({ prdBody, prDiffSummary, prBody }) {
  const m = model("OPENAI_MODEL_REVIEW", "gpt-4.1");

  const system = `You are a strict but practical reviewer. Review implementation against the PRD and acceptance criteria.

Scoring rules (important):
- Your job is to decide whether the PR is READY TO MERGE based on the diff.
- FAIL only when there is a clear, objective mismatch with the PRD/AC, a bug, missing functionality, or a safety/correctness risk.
- Do NOT fail purely because you cannot *visually* verify a "pixel-perfect" UI requirement from code alone.
  - If the AC is inherently visual (layout, spacing, colors) and no screenshots/visual regression results are provided, mark that AC as MANUAL QA REQUIRED, describe exactly what a human should verify, and (if the implementation looks plausible) keep the overall verdict as PASS.

Output MUST be Markdown.

The FIRST LINE MUST be exactly:
Verdict: PASS
OR
Verdict: FAIL

(Do not add Markdown formatting to the PASS/FAIL token; keep it plain text.)

Then include:
- Manual QA required (bullet list; include when any AC cannot be verified from diff alone)
- AC checklist: AC1.. each Pass/Fail/Manual + evidence or rationale
- Key issues (if any)
- Suggested fixes (actionable)

Do not nitpick style unless it affects correctness/safety.`;

  const user = `PRD:\n${prdBody}\n\nPR description:\n${prBody}\n\nDiff summary:\n${prDiffSummary}`;

  return responsesText({ model: m, system, user, temperature: 0.2, json: false });
}
