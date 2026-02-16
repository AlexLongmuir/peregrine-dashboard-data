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
  getPullRequest,
  gitCheckoutBranch,
  gitCheckoutNewBranch,
  gitCommitAll,
  gitConfigUser,
  gitFetchBranch,
  gitPush,
  updatePullRequest,
  cloneRepo,
} from "./github.mjs";
import { planDev, rewritePrdFromIntake, reviewAgainstPrd } from "./openai.mjs";
import { implementFromPrd } from "./implement.mjs";
import { boolEnv, ensureDir, intEnv, newRunId, sh } from "./util.mjs";
import { writeEvent, writeImplementation, writePatch, writePlan, writePrd, writeReview, writeStatus } from "./artifacts.mjs";

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

async function processReadyForDev(page, { humanFeedback = "" } = {}) {  // humanFeedback: used when rerunning from Needs Changes

  const pageId = page.id;
  const issueUrl = readUrl(page, "GitHub Issue");
  const existingPrUrl = readUrl(page, "GitHub PR");
  const runId = readRichText(page, "Run ID") || newRunId(readTitle(page));
  await setRunId(pageId, runId);

  const issueRef = parseIssueFromUrl(issueUrl);
  if (!issueRef) throw new Error(`Missing or invalid GitHub Issue URL on card: ${issueUrl}`);
  const repo = `${issueRef.owner}/${issueRef.repo}`;

  // Mark in progress
  await setStatus(pageId, "In Dev");

  // Pull PRD from GitHub issue body
  const issue = await getIssue({ repo, issueNumber: issueRef.number });
  const prdBody = issue.body || "";

  writeEvent({ root: ROOT, runId, kind: "DEV", text: `Planning`, redact: REDACT });
  const plan = await planDev({ prdBody });
  writePlan({ root: ROOT, runId, planMarkdown: plan, redact: REDACT });

  // Clone target repo
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `peregrine-${runId}-`));
  await cloneRepo({ repo, dir: tmp });
  gitConfigUser({ dir: tmp });

  // Reuse existing PR branch if present
  let pr = null;
  let branch = `peregrine/${runId}`;
  const prRef = parsePrFromUrl(existingPrUrl);
  if (prRef) {
    pr = await getPullRequest({ repo, prNumber: prRef.number });
    branch = pr.head?.ref || branch;
    // fetch and checkout branch
    gitFetchBranch({ dir: tmp, branch });
    gitCheckoutBranch({ dir: tmp, branch });
  } else {
    gitCheckoutNewBranch({ dir: tmp, branch });
  }

  // Implement actual code changes
  writeEvent({ root: ROOT, runId, kind: "DEV", text: `Implementing`, redact: REDACT });
  let impl;
  try {
    impl = await implementFromPrd({ dir: tmp, prdBody, plan, maxIters: 2, humanFeedback });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setLatestFeedback(pageId, msg);
    await setStatus(pageId, "Needs Changes");
    writeEvent({ root: ROOT, runId, kind: "DEV_FAIL", text: msg, redact: true });
    writeStatus({
      root: ROOT,
      runId,
      status: "Needs Changes",
      repo,
      notionUrl: notionPageUrl(page),
      issueUrl: issue.html_url,
      prUrl: existingPrUrl || "",
      redact: REDACT,
    });
    return;
  }

  if (!impl.ok) {
    await setLatestFeedback(pageId, impl.error || "Implementation failed");
    await setStatus(pageId, "Needs Changes");
    writeEvent({ root: ROOT, runId, kind: "DEV_FAIL", text: impl.error || "Implementation failed", redact: true });
    writeStatus({
      root: ROOT,
      runId,
      status: "Needs Changes",
      repo,
      notionUrl: notionPageUrl(page),
      issueUrl: issue.html_url,
      prUrl: existingPrUrl || "",
      redact: REDACT,
    });
    return;
  }

  writePatch({ root: ROOT, runId, patch: impl.patch, redact: true });
  writeImplementation({
    root: ROOT,
    runId,
    md: `## Diff stat\n\n\n\`\`\`\n${impl.diffStat}\n\`\`\`\n\n## Changed files\n${impl.changedFiles.map((f) => `- ${f}`).join("\n")}\n`,
    redact: REDACT,
  });

  // Write a run doc into the repo (optional but useful)
  const docPath = path.join(tmp, "docs", "peregrine");
  ensureDir(docPath);
  fs.writeFileSync(
    path.join(docPath, `${runId}.md`),
    `# Peregrine run ${runId}\n\nIssue: ${issue.html_url}\n\n## Plan\n\n${plan}\n`
  );

  // Commit + push
  gitCommitAll({ dir: tmp, message: `peregrine: implement ${runId}` });
  await gitPush({ dir: tmp, branch, repo });

  // Create PR if needed
  if (!pr) {
    const prTitle = `[peregrine] ${issue.title}`;
    const prBody = `Implements: ${issue.html_url}\n\nArtifacts: (see peregrine-dashboard-data/runs/${runId})\n\n## Manual test script\n- TODO\n\n## EAS Preview\n- TODO\n\n## AC checklist\n- [ ] AC1\n`;

    pr = await createPullRequest({ repo, head: branch, base: "main", title: prTitle, body: prBody });
    await setGitHubPR(pageId, pr.html_url);
    await commentOnIssue({ repo, issueNumber: issueRef.number, body: `Peregrine opened PR: ${pr.html_url}` });
    writeEvent({ root: ROOT, runId, kind: "GITHUB", text: `Opened PR ${pr.html_url}`, redact: REDACT });
  } else {
    // ensure Notion has PR url
    if (!existingPrUrl) await setGitHubPR(pageId, pr.html_url);
  }

  await setLatestFeedback(pageId, `Pushed code changes to ${pr.html_url}`);
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

function parseVerdict(reviewMarkdown) {
  const m = String(reviewMarkdown || "").match(/Verdict:\s*(PASS|FAIL)/i);
  if (!m) return "";
  return m[1].toUpperCase();
}

async function processNeedsChanges(page) {
  const feedback = readRichText(page, "Latest Feedback").trim();
  return processReadyForDev(page, { humanFeedback: feedback });
}

function getPrDiffSummary({ dir, baseRef, headRef }) {
  // Fetch refs into stable local names so we can diff reliably.
  sh("git", ["-C", dir, "fetch", "origin", `${baseRef}:refs/heads/peregrine_base`], { timeout: 60_000 });
  sh("git", ["-C", dir, "fetch", "origin", `${headRef}:refs/heads/peregrine_head`], { timeout: 60_000 });

  const diffStat = sh("git", ["-C", dir, "diff", "peregrine_base...peregrine_head", "--stat"], { timeout: 60_000 }).stdout;
  const changedFiles = sh("git", ["-C", dir, "diff", "peregrine_base...peregrine_head", "--name-only"], { timeout: 60_000 }).stdout;

  return [
    "## Diff stat",
    "",
    "```",
    diffStat.trim() || "(no changes)",
    "```",
    "",
    "## Changed files",
    "",
    ...(changedFiles
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((f) => `- ${f}`)),
  ].join("\n");
}

async function processInReview(page) {
  const pageId = page.id;
  const issueUrl = readUrl(page, "GitHub Issue");
  const prUrl = readUrl(page, "GitHub PR");
  const runId = readRichText(page, "Run ID") || newRunId(readTitle(page));
  await setRunId(pageId, runId);

  const issueRef = parseIssueFromUrl(issueUrl);
  if (!issueRef) throw new Error(`Missing or invalid GitHub Issue URL on card: ${issueUrl}`);
  const prRef = parsePrFromUrl(prUrl);
  if (!prRef) throw new Error(`Missing or invalid GitHub PR URL on card: ${prUrl}`);

  const repo = `${issueRef.owner}/${issueRef.repo}`;

  // Pull PRD from GitHub issue body
  const issue = await getIssue({ repo, issueNumber: issueRef.number });
  const prdBody = issue.body || "";

  const pr = await getPullRequest({ repo, prNumber: prRef.number });

  writeEvent({ root: ROOT, runId, kind: "REVIEW", text: `Reviewing ${pr.html_url}`, redact: REDACT });

  // Compute a basic diff summary (git-based) for the reviewer model.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `peregrine-review-${runId}-`));
  await cloneRepo({ repo, dir: tmp });

  const baseRef = pr.base?.ref || "main";
  const headRef = pr.head?.ref;
  if (!headRef) throw new Error(`PR head ref missing for ${pr.html_url}`);

  const prDiffSummary = getPrDiffSummary({ dir: tmp, baseRef, headRef });

  const review = await reviewAgainstPrd({ prdBody, prDiffSummary, prBody: pr.body || "" });
  writeReview({ root: ROOT, runId, reviewMarkdown: review, redact: REDACT });

  const verdict = parseVerdict(review);
  const truncated = String(review).slice(0, 60_000);
  await commentOnIssue({ repo, issueNumber: prRef.number, body: `## Peregrine review\n\n${truncated}` });

  if (verdict === "PASS") {
    await setLatestFeedback(pageId, "Review PASS — marked Ready to Merge");
    await setStatus(pageId, "Ready to Merge");
    writeStatus({
      root: ROOT,
      runId,
      status: "Ready to Merge",
      repo,
      notionUrl: notionPageUrl(page),
      issueUrl: issue.html_url,
      prUrl: pr.html_url,
      redact: REDACT,
    });
    writeEvent({ root: ROOT, runId, kind: "REVIEW_PASS", text: `Ready to Merge: ${pr.html_url}`, redact: REDACT });
    return;
  }

  // Default to FAIL if we couldn't parse a verdict.
  // Store the review content in Notion so the dev rerun can use it as guidance.
  await setLatestFeedback(pageId, review);
  await setStatus(pageId, "Needs Changes");
  writeStatus({
    root: ROOT,
    runId,
    status: "Needs Changes",
    repo,
    notionUrl: notionPageUrl(page),
    issueUrl: issue.html_url,
    prUrl: pr.html_url,
    redact: REDACT,
  });
  writeEvent({ root: ROOT, runId, kind: "REVIEW_FAIL", text: `Needs Changes: ${pr.html_url}`, redact: REDACT });
}

async function processReadyToMerge(page) {
  const pageId = page.id;
  const issueUrl = readUrl(page, "GitHub Issue");
  const prUrl = readUrl(page, "GitHub PR");
  const runId = readRichText(page, "Run ID") || newRunId(readTitle(page));
  await setRunId(pageId, runId);

  const issueRef = parseIssueFromUrl(issueUrl);
  if (!issueRef) throw new Error(`Missing or invalid GitHub Issue URL on card: ${issueUrl}`);
  const prRef = parsePrFromUrl(prUrl);
  if (!prRef) throw new Error(`Missing or invalid GitHub PR URL on card: ${prUrl}`);

  const repo = `${issueRef.owner}/${issueRef.repo}`;

  const issue = await getIssue({ repo, issueNumber: issueRef.number });
  const pr = await getPullRequest({ repo, prNumber: prRef.number });

  // If merged, we can mark Done.
  if (pr.merged_at) {
    await setLatestFeedback(pageId, `Merged (${pr.merged_at}) — marked Done`);
    await setStatus(pageId, "Done");
    writeStatus({
      root: ROOT,
      runId,
      status: "Done",
      repo,
      notionUrl: notionPageUrl(page),
      issueUrl: issue.html_url,
      prUrl: pr.html_url,
      redact: REDACT,
    });
    writeEvent({ root: ROOT, runId, kind: "MERGED", text: `Merged: ${pr.html_url}`, redact: REDACT });
    return;
  }

  // If closed without merge, bounce it back.
  if (pr.state === "closed") {
    await setLatestFeedback(pageId, "PR closed without merge — sent back to Needs Changes");
    await setStatus(pageId, "Needs Changes");
    writeStatus({
      root: ROOT,
      runId,
      status: "Needs Changes",
      repo,
      notionUrl: notionPageUrl(page),
      issueUrl: issue.html_url,
      prUrl: pr.html_url,
      redact: REDACT,
    });
    writeEvent({ root: ROOT, runId, kind: "PR_CLOSED", text: `Closed without merge: ${pr.html_url}`, redact: REDACT });
  }

  // If still open, do nothing.
}

async function safeHandle(page, fn) {
  // Notion pages are blocks; archived/in_trash pages cannot be edited and will throw:
  // "Can't edit block that is archived".
  if (page?.archived || page?.in_trash) return;

  const pageId = page.id;
  const title = readTitle(page);
  const runId = readRichText(page, "Run ID") || newRunId(title);
  try {
    await fn();
    try {
      await setLastError(pageId, "");
    } catch {
      // ignore Notion write failures (e.g., card archived mid-run)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await setLastError(pageId, msg);
      await setLatestFeedback(pageId, msg);
      await setStatus(pageId, "Error");
    } catch {
      // ignore Notion write failures (e.g., card archived/in trash)
    }
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

  // Needs Changes (rerun dev loop on same PR/branch, using Latest Feedback as guidance)
  const needsChanges = await queryItemsByStatus("Needs Changes");
  const needsChangesItems = (needsChanges.results ?? []).slice(0, max);
  for (const page of needsChangesItems) {
    await safeHandle(page, async () => processNeedsChanges(page));
  }

  // In Review (automated PRD-vs-diff review; advances to Ready to Merge or back to Needs Changes)
  const inReview = await queryItemsByStatus("In Review");
  const inReviewItems = (inReview.results ?? []).slice(0, max);
  for (const page of inReviewItems) {
    await safeHandle(page, async () => processInReview(page));
  }

  // Ready to Merge (if PR merged, mark Done)
  const readyToMerge = await queryItemsByStatus("Ready to Merge");
  const readyToMergeItems = (readyToMerge.results ?? []).slice(0, max);
  for (const page of readyToMergeItems) {
    await safeHandle(page, async () => processReadyToMerge(page));
  }

  // Note: do NOT commit/push artifacts here.
  // The wrapper (OpenClaw cron script) or GitHub Actions workflow should handle committing run artifacts.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
