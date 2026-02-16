import path from "node:path";

import { appendFile, ensureDir, nowIso, redactIfNeeded, writeFile } from "./util.mjs";

export function runDir(root, runId) {
  return path.join(root, "runs", runId);
}

export function writeEvent({ root, runId, kind, text, redact = true }) {
  const dir = runDir(root, runId);
  ensureDir(dir);
  const line = `- ${nowIso()} **${kind}** — ${redactIfNeeded(text, redact).replace(/\n/g, " ")}\n`;
  appendFile(path.join(dir, "EVENTS.md"), line);
}

export function writeStatus({ root, runId, status, repo, notionUrl, issueUrl, prUrl, redact = true }) {
  const dir = runDir(root, runId);
  ensureDir(dir);
  const md = [
    `# STATUS`,
    ``,
    `- Updated: ${nowIso()}`,
    `- Status: **${status}**`,
    repo ? `- Target repo: \\`${repo}\\`` : null,
    notionUrl ? `- Notion: ${notionUrl}` : null,
    issueUrl ? `- GitHub Issue: ${issueUrl}` : null,
    prUrl ? `- GitHub PR: ${prUrl}` : null,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  writeFile(path.join(dir, "STATUS.md"), redactIfNeeded(md, false));
}

export function writePrd({ root, runId, prdMarkdown, redact = true }) {
  const dir = runDir(root, runId);
  ensureDir(dir);
  writeFile(path.join(dir, "PRD.md"), redactIfNeeded(prdMarkdown, redact));
}

export function writePlan({ root, runId, planMarkdown, redact = true }) {
  const dir = runDir(root, runId);
  ensureDir(dir);
  writeFile(path.join(dir, "IMPLEMENTATION_PLAN.md"), redactIfNeeded(planMarkdown, redact));
}

export function writeReview({ root, runId, reviewMarkdown, redact = true }) {
  const dir = runDir(root, runId);
  ensureDir(dir);
  writeFile(path.join(dir, "REVIEW.md"), redactIfNeeded(reviewMarkdown, redact));
}
