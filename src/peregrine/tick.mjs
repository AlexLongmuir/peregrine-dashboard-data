#!/usr/bin/env node

/**
 * Peregrine tick loop: polls Notion Kanban and advances items through the workflow.
 *
 * MVP scope implemented:
 *  - Intake -> create GitHub issue + PRD rewrite
 *  - Ready for Dev -> generate plan (no code changes yet) + open scaffolding PR
 *  - Writes run artifacts under runs/<runId>/
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  queryItemsByStatus,
  readRichText,
  readTitle,
  readUrl,
  setGitHubIssue,
  setGitHubPR,
  setLastError,
  setLatestFeedback,
  setRunId,
  setStatus,
  updatePage,
} from "./notion.mjs";
import {
  commentOnIssue,
  createIssue,
  createPullRequest,
  getIssue,
  gitCheckoutNewBranch,
  gitCommitAll,
  gitConfigUser,
  gitPush,
  parseRepo,
  cloneRepo,
} from "./github.mjs";
import { planDev, rewritePrdFromIntake } from "./openai.mjs";
import { boolEnv, ensureDir, intEnv, newRunId, sh } from "./util.mjs";
import { writeEvent, writePlan, writePrd, writeStatus } from "./artifacts.mjs";

const ROOT = process.cwd();
const REDACT = boolEnv("PEREGRINE_REDACT_ARTIFACTS", true);

function notionPageUrl(page) {
  return page.url || "";
}

function parseIssueFromUrl(url) {
  // https://github.com/owner/repo/issues/123
  const m = String(url || "").match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function parsePrFromUrl(url) {
  const m = String(url || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

async function processIntake(page) {
  const pageId = page.id;
  const title = readTitle(page);
  const roughDraft = readRichText(page, "Rough Draft");
  const targetRepo = readRichText(page, "Target Repo").trim();
  if (!targetRepo) throw new Error(`Missing Target Repo on Notion card ${pageId}`);

  // Assign run id if missing
  const runId = readRichText(page, "Run ID") || newRunId(title);
  await setRunId(pageId, runId);

  writeEvent({ root: ROOT, runId, kind: "INTAKE", text: `Notion intake received: ${title}`, redact: REDACT });

  const prd = await rewritePrdFromIntake({ title, roughDraft, targetRepo });
  writePrd({ root: ROOT, runId, prdMarkdown: prd.body, redact: REDACT });

  writeEvent({ root: ROOT, runId, kind: "PRD_AGENT", text: `PRD drafted`, redact: REDACT });

  const issue = await createIssue({ repo: targetRepo, title: prd.title, body: prd.body });
  await setGitHubIssue(pageId, issue.html_url);

  writeEvent({ root: ROOT, runId, kind: "GITHUB", text: `Created issue ${issue.html_url}`, redact: REDACT });

  await setStatus(pageId, "PRD Drafted");
  writeStatus({
    root: ROOT,
    runId,
    status: "PRD Drafted",
    repo: targetRepo,
    notionUrl: notionPageUrl(page),
    issueUrl: issue.html_url,
    prUrl: "",
    redact: REDACT,
  });

  // Optional: mirror PRD title back into Notion name.
  await updatePage(pageId, {
    Name: { title: [{ text: { content: prd.title.slice(0, 250) } }] },
  });
}

async function processReadyForDev(page) {
  const pageId = page.id;
  const targetRepo = readRichText(page, "Target Repo").trim();
  const issueUrl = readUrl(page, "GitHub Issue");
  const runId = readRichText(page, "Run ID") || newRunId(readTitle(page));
  await setRunId(pageId, runId);

  const issueRef = parseIssueFromUrl(issueUrl);
  if (!issueRef) throw new Error(`Missing or invalid GitHub Issue URL on card: ${issueUrl}`);
  const repo = `${issueRef.owner}/${issueRef.repo}`;

  // Pull PRD from GitHub issue body
  const issue = await getIssue({ repo, issueNumber: issueRef.number });
  const prdBody = issue.body || "";

  writeEvent({ root: ROOT, runId, kind: "DEV", text: `Planning`, redact: REDACT });
  const plan = await planDev({ prdBody });
  writePlan({ root: ROOT, runId, planMarkdown: plan, redact: REDACT });

  // Create a scaffolding PR in the target repo.
  // NOTE: This does NOT implement code changes yet; it creates a branch + adds docs/peregrine/<runId>.md
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `peregrine-${runId}-`));
  await cloneRepo({ repo, dir: tmp });
  gitConfigUser({ dir: tmp });

  const branch = `peregrine/${runId}`;
  gitCheckoutNewBranch({ dir: tmp, branch });

  const docPath = path.join(tmp, "docs", "peregrine");
  ensureDir(docPath);
  fs.writeFileSync(
    path.join(docPath, `${runId}.md`),
    `# Peregrine run ${runId}\n\nIssue: ${issue.html_url}\n\n## Plan\n\n${plan}\n`
  );

  gitCommitAll({ dir: tmp, message: `peregrine: plan for ${runId}` });
  await gitPush({ dir: tmp, branch, repo });

  const prTitle = `[peregrine] ${issue.title}`;
  const prBody = `Implements: ${issue.html_url}\n\nArtifacts: (see peregrine-dashboard-data/runs/${runId})\n\n## Manual test script\n- TODO\n\n## EAS Preview\n- TODO\n\n## AC checklist\n- [ ] AC1\n`;

  const pr = await createPullRequest({ repo, head: branch, base: "main", title: prTitle, body: prBody });
  await setGitHubPR(pageId, pr.html_url);

  writeEvent({ root: ROOT, runId, kind: "GITHUB", text: `Opened PR ${pr.html_url}`, redact: REDACT });
  await commentOnIssue({ repo, issueNumber: issueRef.number, body: `Peregrine opened PR: ${pr.html_url}` });

  await setStatus(pageId, "In Review");
  writeStatus({
    root: ROOT,
    runId,
    status: "In Review",
    repo,
    notionUrl: notionPageUrl(page),
    issueUrl: issue.html_url,
    prUrl: pr.html_url,
    redact: REDACT,
  });
}

async function safeHandle(page, fn) {
  const pageId = page.id;
  const title = readTitle(page);
  const runId = readRichText(page, "Run ID") || newRunId(title);
  try {
    await fn();
    await setLastError(pageId, "");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setLastError(pageId, msg);
    await setLatestFeedback(pageId, msg);
    await setStatus(pageId, "Error");
    writeEvent({ root: ROOT, runId, kind: "ERROR", text: msg, redact: true });
  }
}

async function main() {
  const max = intEnv("PEREGRINE_MAX_ITEMS", 10);

  // Intake
  const intake = await queryItemsByStatus("Intake");
  const intakeItems = (intake.results ?? []).slice(0, max);
  for (const page of intakeItems) {
    await safeHandle(page, async () => processIntake(page));
  }

  // Ready for Dev
  const ready = await queryItemsByStatus("Ready for Dev");
  const readyItems = (ready.results ?? []).slice(0, max);
  for (const page of readyItems) {
    await safeHandle(page, async () => processReadyForDev(page));
  }

  // Note: do NOT commit/push artifacts here.
  // The wrapper (OpenClaw cron script) or GitHub Actions workflow should handle committing run artifacts.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
