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
import crypto from "node:crypto";

import {
  createCard,
  ensureProperties,
  ensureSelectOptions,
  queryItemsByName,
  queryItemsByStatus,
  readCheckbox,
  readDateStart,
  readNumber,
  readRelationIds,
  readRichText,
  readSelect,
  readTargetRepo,
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
  ensureOriginToken,
  getIssue,
  getPullRequest,
  mergePullRequest,
  listInstallationRepos,
  gitCheckoutBranch,
  gitCheckoutNewBranch,
  gitCommitAll,
  gitConfigUser,
  gitFetchBranch,
  gitPush,
  updatePullRequest,
  cloneRepo,
} from "./github.mjs";
import { planDev, rewritePrdFromIntake, reviewAgainstPrd, scopeTriageFromIntake, scopeTriageFromPrd } from "./openai.mjs";
import { implementFromPrd } from "./implement.mjs";
import { boolEnv, ensureDir, intEnv, newRunId, readFileIfExists, writeFile, sh } from "./util.mjs";
import { writeEvent, writeImplementation, writePatch, writePlan, writePrd, writeReview, writeScope, writeStatus } from "./artifacts.mjs";

const ROOT = process.cwd();
const WORKSPACE = path.resolve(ROOT, "..");
const AUTOHEAL_STATE_PATH = path.join(WORKSPACE, ".tmp", "peregrine_autoheal_state.json");
const AUTOHEAL_ENABLED = boolEnv("PEREGRINE_AUTOHEAL", true);
const AUTOHEAL_MAX_ITEMS = intEnv("PEREGRINE_AUTOHEAL_MAX_ITEMS", 25);
const REDACT = boolEnv("PEREGRINE_REDACT_ARTIFACTS", true);
const MAX_PACKAGES = intEnv("PEREGRINE_MAX_PACKAGES", 10);
const INTAKE_AUTOSPLIT = boolEnv("PEREGRINE_INTAKE_AUTOSPLIT", false);
const EPIC_STATUS = process.env.PEREGRINE_EPIC_STATUS || "Epic";
const PARENT_REL_PROP = process.env.PEREGRINE_PARENT_RELATION_PROP || "Parent";
const CHILDREN_REL_PROP = process.env.PEREGRINE_CHILDREN_RELATION_PROP || "Children";

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

const REQUIRED_STATUSES = [
  "Intake",
  "PRD Drafted",
  "Ready for Dev",
  "In Dev",
  "In Review",
  "Needs Changes",
  "Ready to Merge",
  "Done",
  "Error",
  EPIC_STATUS,
];

// Control card properties (live on the same Notion Kanban database)
const CONTROL_WORK_SESSION_ENABLED = "Work Session Enabled";
const CONTROL_WORK_SESSION_ENDS_AT = "Work Session Ends At";
const CONTROL_WORK_SESSION_ACTION_BUDGET = "Work Session LLM Action Budget";
const CONTROL_WORK_SESSION_ACTIONS_USED = "Work Session LLM Actions Used";
const CONTROL_WORK_SESSION_MAX_ITEMS = "Work Session Max Items/Tick";
const CONTROL_WORK_SESSION_MAX_LLM_ACTIONS = "Work Session Max LLM Actions/Tick";

// Card-level merge gate
const MERGE_REQUESTED_PROP = "Merge Requested";
const MERGE_APPROVED_PROP = "Merge Approved";
const MERGE_METHOD_PROP = "Merge Method";

function autohealSig(text) {
  const t = String(text || "").trim();
  return crypto.createHash("sha1").update(t.slice(0, 4000)).digest("hex").slice(0, 12);
}

function loadAutohealState() {
  const raw = readFileIfExists(AUTOHEAL_STATE_PATH);
  if (!raw) return { version: 1, pages: {} };
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return { version: 1, pages: {} };
    if (!j.pages || typeof j.pages !== "object") j.pages = {};
    return j;
  } catch {
    return { version: 1, pages: {} };
  }
}

function saveAutohealState(state) {
  // Best-effort write; never let this crash the tick.
  try {
    writeFile(AUTOHEAL_STATE_PATH, JSON.stringify(state, null, 2) + "\\n");
  } catch {
    // ignore
  }
}

function recordErrorForAutoheal({ pageId, stage, errorText }) {
  if (!AUTOHEAL_ENABLED) return;
  const state = loadAutohealState();
  const pages = state.pages || (state.pages = {});
  const entry = pages[pageId] || (pages[pageId] = { autoheal: {} });

  entry.lastStage = stage || entry.lastStage || "";
  entry.lastErrorSig = autohealSig(errorText);
  entry.lastError = String(errorText || "").slice(0, 800);
  entry.lastSeenAt = new Date().toISOString();

  saveAutohealState(state);
}

function shouldAttemptAutoheal({ pageId, sig }) {
  if (!AUTOHEAL_ENABLED) return false;
  const state = loadAutohealState();
  const entry = state.pages?.[pageId];
  const prior = entry?.autoheal?.[sig];
  return !prior?.attemptedAt;
}

function markAutohealAttempt({ pageId, sig, result }) {
  const state = loadAutohealState();
  const pages = state.pages || (state.pages = {});
  const entry = pages[pageId] || (pages[pageId] = { autoheal: {} });
  entry.autoheal = entry.autoheal || {};
  entry.autoheal[sig] = {
    attemptedAt: new Date().toISOString(),
    ...(result || {}),
  };
  saveAutohealState(state);
}

function inferRecoveredStatus(page, stage) {
  const issueUrl = readUrl(page, "GitHub Issue");
  const prUrl = readUrl(page, "GitHub PR");
  const hasIssue = Boolean(parseIssueFromUrl(issueUrl));
  const hasPr = Boolean(parsePrFromUrl(prUrl));

  if (hasPr) return "In Review";

  if (hasIssue) {
    if (stage === "Ready for Dev" || stage === "Needs Changes") return stage;
    // If we made it far enough to create an issue, the safest recovery is PRD Drafted.
    return "PRD Drafted";
  }

  return "Intake";
}

function looksLikeNotionMissingSelectOption(errText) {
  const t = String(errText || "");
  if (!t.toLowerCase().includes("notion")) return false;
  // Notion's validation error bodies vary; keep this broad but conservative.
  const hasStatus = /Status/.test(t) || t.includes('"Status"');
  const looksLikeOption = t.toLowerCase().includes("select") && (t.toLowerCase().includes("option") || t.toLowerCase().includes("equals"));
  return hasStatus && looksLikeOption;
}

function looksLikeOpenAiQuotaOrAuth(errText) {
  const t = String(errText || "").toLowerCase();
  return (
    t.includes("insufficient_quota") ||
    t.includes("you exceeded your current quota") ||
    t.includes("invalid_api_key") ||
    t.includes("incorrect api key") ||
    t.includes("401") && t.includes("openai") ||
    t.includes("429") && t.includes("openai")
  );
}

async function processIntake(page) {
  const pageId = page.id;
  const title = readTitle(page);
  const roughDraft = readRichText(page, "Rough Draft");
  const targetRepo = readTargetRepo(page).trim();
  if (!targetRepo) throw new Error(`Missing Target Repo on Notion card ${pageId}`);

  const existingIssueUrl = readUrl(page, "GitHub Issue").trim();

  // Assign run id if missing
  const runId = readRichText(page, "Run ID") || newRunId(title);
  await setRunId(pageId, runId);

  writeEvent({ root: ROOT, runId, kind: "INTAKE", text: `Notion intake received: ${title}`, redact: REDACT });

  // Idempotency guard: if an issue already exists, don't create duplicates.
  // This commonly happens when the run created the issue but failed to move status due to a Notion schema/config error.
  if (existingIssueUrl && parseIssueFromUrl(existingIssueUrl)) {
    await setLatestFeedback(pageId, `Detected existing GitHub Issue; skipping PRD/Issue creation and advancing to PRD Drafted. (${existingIssueUrl})`);
    await setStatus(pageId, "PRD Drafted");
    writeStatus({
      root: ROOT,
      runId,
      status: "PRD Drafted",
      repo: targetRepo,
      notionUrl: notionPageUrl(page),
      issueUrl: existingIssueUrl,
      prUrl: "",
      redact: REDACT,
    });
    return;
  }

  const hasParentRel = Boolean(page?.properties?.[PARENT_REL_PROP]?.type === "relation" || page?.properties?.[PARENT_REL_PROP]?.relation);
  const hasChildrenRel = Boolean(page?.properties?.[CHILDREN_REL_PROP]?.type === "relation" || page?.properties?.[CHILDREN_REL_PROP]?.relation);
  const autosplitReady = INTAKE_AUTOSPLIT && hasParentRel && hasChildrenRel;

  const isChild = autosplitReady ? readRelationIds(page, PARENT_REL_PROP).length > 0 : false;
  const existingChildren = autosplitReady ? readRelationIds(page, CHILDREN_REL_PROP) : [];

  // If this is already split (has children) but is still in Intake, move it to Epic and STOP.
  if (autosplitReady && !isChild && existingChildren.length > 0) {
    await setLatestFeedback(
      pageId,
      `Already split into ${existingChildren.length} child card(s). Each child will create its own issue/PR. (Parent auto-moved out of Intake.)`
    );
    try {
      await setStatus(pageId, EPIC_STATUS);
    } catch {
      // If Epic status isn't configured in Notion, don't fail the tick.
      await setStatus(pageId, "PRD Drafted");
    }

    writeStatus({
      root: ROOT,
      runId,
      status: EPIC_STATUS,
      repo: targetRepo,
      notionUrl: notionPageUrl(page),
      issueUrl: "",
      prUrl: "",
      redact: REDACT,
    });
    return;
  }

  if (INTAKE_AUTOSPLIT && !autosplitReady) {
    writeEvent({
      root: ROOT,
      runId,
      kind: "SPLIT_SKIP",
      text: `Auto-split enabled but Notion relation props not available (expected "${PARENT_REL_PROP}" and "${CHILDREN_REL_PROP}")`,
      redact: REDACT,
    });
  }

  // Scope triage (best-effort): decide single vs split and propose work packages.
  let scope = null;
  try {
    scope = await scopeTriageFromIntake({ title, roughDraft, targetRepo, maxPackages: MAX_PACKAGES });
    writeScope({ root: ROOT, runId, scopeJson: scope, fileName: "SCOPE.md", redact: REDACT });
    writeEvent({ root: ROOT, runId, kind: "SCOPE", text: `Scope triage: ${scope.decision || ""}`, redact: REDACT });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordErrorForAutoheal({ pageId, stage, errorText: msg });
    writeEvent({ root: ROOT, runId, kind: "SCOPE_FAIL", text: msg, redact: true });
  }

  // Auto-split Intake into child cards (Epic + children)
  const shouldSplit = autosplitReady && !isChild && scope?.decision === "split" && Array.isArray(scope?.packages) && scope.packages.length > 1;
  if (shouldSplit) {
    const pkgs = (scope.packages || []).slice(0, MAX_PACKAGES);

    const childPages = [];
    let relationWorked = true;

    for (let i = 0; i < pkgs.length; i += 1) {
      const p = pkgs[i] || {};
      const n = pkgs.length;

      const childTitle = `${title} — ${i + 1}/${n} ${String(p.name || "").trim()}`.slice(0, 250).trim();
      const childRough = [
        `Parent: ${title}`,
        `Target repo: ${targetRepo}`,
        ``,
        `Work package ${i + 1}/${n}: ${String(p.name || "").trim()}`,
        String(p.goal || "") ? `Goal: ${String(p.goal || "").trim()}` : null,
        Array.isArray(p.acceptance_criteria_subset) && p.acceptance_criteria_subset.length
          ? ["Acceptance criteria:", ...p.acceptance_criteria_subset.slice(0, 8).map((x) => `- ${x}`)].join("\n")
          : null,
        Array.isArray(p.likely_files_areas) && p.likely_files_areas.length
          ? ["Likely areas:", ...p.likely_files_areas.slice(0, 8).map((x) => `- ${x}`)].join("\n")
          : null,
        Array.isArray(p.deps) && p.deps.length ? `Depends on: ${p.deps.join(", ")}` : null,
        String(p.risk || "") ? `Risk: ${String(p.risk || "").trim()}` : null,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000);

      let child;
      try {
        // Best-effort: set Parent relation and Target Repo (select). Fall back gracefully if props don't exist.
        child = await createCard({
          title: childTitle,
          roughDraft: childRough,
          targetRepo,
          status: "Intake",
          extraProperties: {
            [PARENT_REL_PROP]: { relation: [{ id: pageId }] },
            "Target Repo (select)": { select: { name: targetRepo } },
          },
        });
      } catch (e1) {
        try {
          child = await createCard({
            title: childTitle,
            roughDraft: childRough,
            targetRepo,
            status: "Intake",
            extraProperties: {
              [PARENT_REL_PROP]: { relation: [{ id: pageId }] },
            },
          });
        } catch (e2) {
          relationWorked = false;
          child = await createCard({ title: childTitle, roughDraft: childRough, targetRepo, status: "Intake" });
        }
      }

      childPages.push(child);
    }

    const childLinks = childPages
      .map((c, idx) => {
        const url = c?.url || "";
        return `- ${idx + 1}. ${url || "(created)"}`;
      })
      .join("\n");

    await setLatestFeedback(
      pageId,
      [
        `Auto-split into ${childPages.length} child card(s). Each child will generate its own GitHub Issue + PR.`,
        relationWorked ? null : `Note: Couldn't set Notion relation property "${PARENT_REL_PROP}" (missing or misnamed). Child cards were still created.`,
        "",
        childLinks,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000)
    );

    // Mark parent as Epic so it doesn't create its own Issue/PR.
    try {
      await setStatus(pageId, EPIC_STATUS);
    } catch {
      await setStatus(pageId, "PRD Drafted");
    }

    // Mirror name so it's visually obvious this is not a leaf card.
    try {
      await updatePage(pageId, {
        Name: { title: [{ text: { content: `EPIC: ${title}`.slice(0, 250) } }] },
      });
    } catch {
      // ignore
    }

    writeEvent({ root: ROOT, runId, kind: "SPLIT", text: `Auto-split into ${childPages.length} child card(s).`, redact: REDACT });

    writeStatus({
      root: ROOT,
      runId,
      status: EPIC_STATUS,
      repo: targetRepo,
      notionUrl: notionPageUrl(page),
      issueUrl: "",
      prUrl: "",
      redact: REDACT,
    });

    return;
  }

  // Default behavior (leaf card): PRD rewrite + GitHub Issue
  const prd = await rewritePrdFromIntake({ title, roughDraft, targetRepo, scope });
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

  // Scope triage from PRD (best-effort): used to split dev work into sequential packages.
  let devScope = null;
  try {
    devScope = await scopeTriageFromPrd({ prdBody, maxPackages: MAX_PACKAGES });
    writeScope({ root: ROOT, runId, scopeJson: devScope, fileName: "SCOPE_DEV.md", redact: REDACT });
    writeEvent({ root: ROOT, runId, kind: "SCOPE_DEV", text: `Dev scope: ${devScope.decision || ""} (${(devScope.packages || []).length} pkgs)`, redact: REDACT });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordErrorForAutoheal({ pageId, stage, errorText: msg });
    writeEvent({ root: ROOT, runId, kind: "SCOPE_DEV_FAIL", text: msg, redact: true });
  }

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
    await gitFetchBranch({ dir: tmp, branch, repo });
    gitCheckoutBranch({ dir: tmp, branch });
  } else {
    gitCheckoutNewBranch({ dir: tmp, branch });
  }

  // Implement actual code changes
  writeEvent({ root: ROOT, runId, kind: "DEV", text: `Implementing`, redact: REDACT });
  let impl;
  try {
    impl = await implementFromPrd({
      dir: tmp,
      prdBody,
      plan,
      maxIters: intEnv("PEREGRINE_DEV_MAX_ITERS", 2),
      humanFeedback,
      packages: Array.isArray(devScope?.packages) ? devScope.packages : null,
      maxPackages: MAX_PACKAGES,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordErrorForAutoheal({ pageId, stage, errorText: msg });
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

  const pkgSummary = Array.isArray(devScope?.packages) && devScope.packages.length
    ? [
        "## Work packages",
        "",
        ...devScope.packages.slice(0, MAX_PACKAGES).map((p, idx) => {
          const name = String(p?.name || `Package ${idx + 1}`);
          const goal = String(p?.goal || "");
          return `- ${idx + 1}. **${name}**${goal ? ` — ${goal}` : ""}`;
        }),
        "",
      ].join("\n")
    : "";

  writeImplementation({
    root: ROOT,
    runId,
    md: `${pkgSummary}## Diff stat\n\n\n\`\`\`\n${impl.diffStat}\n\`\`\`\n\n## Changed files\n${impl.changedFiles.map((f) => `- ${f}`).join("\n")}\n`,
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
  // The reviewer is instructed to output a line like:
  //   Verdict: PASS
  // But LLMs sometimes add Markdown formatting (e.g. **PASS** or headings like "## Verdict: **FAIL**").
  // Be tolerant so we don't strand cards in Needs Changes due to formatting.
  const text = String(reviewMarkdown || "");

  // Strip common inline-markdown emphasis/code markers.
  const cleaned = text.replace(/[*_`]/g, "");

  // Prefer a verdict at the start of a line (supports headings/bullets/quotes).
  const m = cleaned.match(/^[\s>#\-]*Verdict\s*:\s*(PASS|FAIL)\b/im);
  if (!m) return "";
  return m[1].toUpperCase();
}

async function processNeedsChanges(page) {
  const pageId = page.id;
  const feedback = readRichText(page, "Latest Feedback").trim();

  // If the card was bumped to Needs Changes due to a verdict parsing bug,
  // the auto-review text may already be stored in Latest Feedback.
  // Detect that and advance without re-running dev.
  const existingVerdict = parseVerdict(feedback);
  if (existingVerdict === "PASS") {
    const issueUrl = readUrl(page, "GitHub Issue");
    const prUrl = readUrl(page, "GitHub PR");
    const runId = readRichText(page, "Run ID") || newRunId(readTitle(page));
    await setRunId(pageId, runId);

    const issueRef = parseIssueFromUrl(issueUrl);
    const repo = issueRef ? `${issueRef.owner}/${issueRef.repo}` : "";

    await setLatestFeedback(pageId, "Review PASS (from Latest Feedback) — marked Ready to Merge");
    await setStatus(pageId, "Ready to Merge");
    try {
      await updatePage(pageId, {
        [MERGE_REQUESTED_PROP]: { checkbox: true },
        [MERGE_APPROVED_PROP]: { checkbox: false },
      });
    } catch {
      // ignore
    }
    writeStatus({
      root: ROOT,
      runId,
      status: "Ready to Merge",
      repo,
      notionUrl: notionPageUrl(page),
      issueUrl,
      prUrl,
      redact: REDACT,
    });
    writeEvent({ root: ROOT, runId, kind: "REVIEW_PASS", text: `Ready to Merge (from Latest Feedback): ${prUrl}`, redact: REDACT });
    return;
  }

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
  // Best-effort: ensure origin URL includes a fresh token before additional fetches.
  try {
    await ensureOriginToken({ dir: tmp, repo });
  } catch {
    // ignore
  }

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
    try {
      await updatePage(pageId, {
        [MERGE_REQUESTED_PROP]: { checkbox: true },
        [MERGE_APPROVED_PROP]: { checkbox: false },
      });
    } catch {
      // ignore
    }
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
    try {
      await updatePage(pageId, {
        [MERGE_REQUESTED_PROP]: { checkbox: false },
        [MERGE_APPROVED_PROP]: { checkbox: false },
      });
    } catch {
      // ignore
    }
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

  // If approved for merge, attempt the merge (default method: squash).
  const mergeApproved = readCheckbox(page, MERGE_APPROVED_PROP);
  if (mergeApproved) {
    const methodRaw = (readSelect(page, MERGE_METHOD_PROP) || "squash").toLowerCase();
    const mergeMethod = methodRaw === "merge" || methodRaw === "rebase" || methodRaw === "squash" ? methodRaw : "squash";

    try {
      const res = await mergePullRequest({ repo, prNumber: prRef.number, mergeMethod });
      if (res?.merged) {
        await setLatestFeedback(pageId, `Merged via ${mergeMethod} — marked Done`);
        await setStatus(pageId, "Done");
        try {
          await updatePage(pageId, {
            [MERGE_REQUESTED_PROP]: { checkbox: false },
            [MERGE_APPROVED_PROP]: { checkbox: false },
          });
        } catch {
          // ignore
        }
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
        writeEvent({ root: ROOT, runId, kind: "MERGED", text: `Merged (api/${mergeMethod}): ${pr.html_url}`, redact: REDACT });
        return;
      }

      await setLatestFeedback(pageId, `Merge attempted (method=${mergeMethod}) but GitHub reports not merged: ${res?.message || "unknown"}`.slice(0, 2000));
      return; // stay in Ready to Merge
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Do NOT throw: keep card in Ready to Merge and let PM/human decide.
      await setLatestFeedback(pageId, `Merge failed (method=${mergeMethod}): ${msg}`.slice(0, 2000));
      return;
    }
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

async function safeHandle(page, { stage = "" } = {}, fn) {
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
    recordErrorForAutoheal({ pageId, stage, errorText: msg });
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

async function getAiFlowControl() {
  // Master switch lives in a dedicated Notion card.
  // If switch is missing/unreadable, default to enabled.
  const controlTitle = process.env.PEREGRINE_CONTROL_CARD_TITLE || "🧭 Peregrine Control — AI Flow Master Switch";

  const empty = {
    enabled: true,
    intervalMin: 0,
    lastRunAtMs: 0,
    runNow: false,
    pageId: "",

    workSessionEnabled: false,
    workSessionEndsAtMs: 0,
    workSessionActionBudget: 0,
    workSessionActionsUsed: 0,
    workSessionMaxItems: null,
    workSessionMaxLlmActions: null,
  };

  try {
    const res = await queryItemsByName(controlTitle);
    const page = (res?.results ?? [])[0];
    if (!page) return empty;

    const enabled = readCheckbox(page, "AI Flow Enabled");
    const intervalMin = Math.max(0, Math.round(readNumber(page, "AI Tick Interval (min)") ?? 0));
    const runNow = readCheckbox(page, "AI Tick Run Now");

    const lastIso = readDateStart(page, "AI Tick Last Run");
    const lastRunAtMs = lastIso ? Date.parse(lastIso) : 0;

    const workSessionEnabled = readCheckbox(page, CONTROL_WORK_SESSION_ENABLED);
    const endsIso = readDateStart(page, CONTROL_WORK_SESSION_ENDS_AT);
    const workSessionEndsAtMs = endsIso ? Date.parse(endsIso) : 0;

    const workSessionActionBudget = Math.max(0, Math.round(readNumber(page, CONTROL_WORK_SESSION_ACTION_BUDGET) ?? 0));
    const workSessionActionsUsed = Math.max(0, Math.round(readNumber(page, CONTROL_WORK_SESSION_ACTIONS_USED) ?? 0));

    const workSessionMaxItems = readNumber(page, CONTROL_WORK_SESSION_MAX_ITEMS);
    const workSessionMaxLlmActions = readNumber(page, CONTROL_WORK_SESSION_MAX_LLM_ACTIONS);

    return {
      enabled,
      intervalMin,
      lastRunAtMs,
      runNow,
      pageId: page.id,

      workSessionEnabled,
      workSessionEndsAtMs,
      workSessionActionBudget,
      workSessionActionsUsed,
      workSessionMaxItems,
      workSessionMaxLlmActions,
    };
  } catch {
    return empty;
  }
}

async function main() {
  // Best-effort: ensure Phase-1 properties exist on the Kanban database.
  // (This keeps cards from getting stranded when properties are missing.)
  try {
    await ensureProperties([
      { name: CONTROL_WORK_SESSION_ENABLED, type: "checkbox" },
      { name: CONTROL_WORK_SESSION_ENDS_AT, type: "date" },
      { name: CONTROL_WORK_SESSION_ACTION_BUDGET, type: "number" },
      { name: CONTROL_WORK_SESSION_ACTIONS_USED, type: "number" },
      { name: CONTROL_WORK_SESSION_MAX_ITEMS, type: "number" },
      { name: CONTROL_WORK_SESSION_MAX_LLM_ACTIONS, type: "number" },

      { name: MERGE_REQUESTED_PROP, type: "checkbox" },
      { name: MERGE_APPROVED_PROP, type: "checkbox" },
      { name: MERGE_METHOD_PROP, type: "select", schema: { options: [] } },
    ]);
  } catch {
    // ignore
  }
  try {
    await ensureSelectOptions({ propName: MERGE_METHOD_PROP, optionNames: ["squash", "merge", "rebase"] });
  } catch {
    // ignore
  }

  // Defaults (can be overridden by Work Session controls)
  let max = intEnv("PEREGRINE_MAX_ITEMS", 10);
  let maxLlmActions = intEnv("PEREGRINE_MAX_LLM_ACTIONS_PER_TICK", max);
  let llmActions = 0;

  // Work session budget accounting (persisted on the control card)
  let sessionActionBudget = 0;
  let sessionActionsUsedStart = 0;
  let sessionActionsUsedDelta = 0;

  // Global on/off switch + configurable cadence (prevents any GitHub/LLM work when off).
  const ctl = await getAiFlowControl();
  if (!ctl.enabled) {
    console.log("Peregrine: AI flow disabled via Notion master switch; exiting tick.");
    return;
  }

  // Work Session gating: PM controls when the automation is allowed to do any work.
  if (!ctl.workSessionEnabled) {
    console.log("Peregrine: work session disabled; exiting tick.");
    return;
  }

  const now = Date.now();
  if (ctl.workSessionEndsAtMs && now > ctl.workSessionEndsAtMs) {
    console.log("Peregrine: work session ended; disabling work session + AI flow.");
    if (ctl.pageId) {
      try {
        await updatePage(ctl.pageId, {
          [CONTROL_WORK_SESSION_ENABLED]: { checkbox: false },
          "AI Flow Enabled": { checkbox: false },
        });
      } catch {
        // ignore
      }
    }
    return;
  }

  // Work session overrides
  if (typeof ctl.workSessionMaxItems === "number" && ctl.workSessionMaxItems > 0) {
    max = Math.max(1, Math.round(ctl.workSessionMaxItems));
  }
  if (typeof ctl.workSessionMaxLlmActions === "number" && ctl.workSessionMaxLlmActions > 0) {
    maxLlmActions = Math.max(1, Math.round(ctl.workSessionMaxLlmActions));
  }

  sessionActionBudget = Math.max(0, Math.round(ctl.workSessionActionBudget || 0));
  sessionActionsUsedStart = Math.max(0, Math.round(ctl.workSessionActionsUsed || 0));

  if (sessionActionBudget > 0 && sessionActionsUsedStart >= sessionActionBudget) {
    console.log("Peregrine: work session LLM action budget exhausted; disabling work session + AI flow.");
    if (ctl.pageId) {
      try {
        await updatePage(ctl.pageId, {
          [CONTROL_WORK_SESSION_ENABLED]: { checkbox: false },
          "AI Flow Enabled": { checkbox: false },
        });
      } catch {
        // ignore
      }
    }
    return;
  }

  async function handleLlmAction(page, stage, fn) {
    if (llmActions >= maxLlmActions) return false;
    if (sessionActionBudget > 0 && sessionActionsUsedStart + sessionActionsUsedDelta >= sessionActionBudget) return false;
    llmActions += 1;
    sessionActionsUsedDelta += 1;
    await safeHandle(page, { stage }, fn);
    return true;
  }

  if (!ctl.runNow && ctl.intervalMin > 0 && ctl.lastRunAtMs > 0) {
    const elapsedMs = Date.now() - ctl.lastRunAtMs;
    if (elapsedMs < ctl.intervalMin * 60_000) {
      return; // too soon; noop
    }
  }

  // Stamp last-run at start so overlapping cron triggers don't double-run.
  // Also auto-clear "Run Now" so it behaves like a one-shot trigger.
  if (ctl.pageId) {
    try {
      await updatePage(ctl.pageId, {
        "AI Tick Last Run": { date: { start: new Date().toISOString() } },
        "AI Tick Run Now": { checkbox: false },
      });
    } catch {
      // ignore
    }
  }

  // Keep the Target Repo dropdown in sync with repos the GitHub App can access.
  // Best-effort: never fail the whole tick if this breaks.
  try {
    const repos = await listInstallationRepos({ perPage: 100 });
    await ensureSelectOptions({ propName: "Target Repo (select)", optionNames: repos });
  } catch {
    // ignore
  }

  // Best-effort: ensure the Kanban Status select has the core workflow options so setStatus() doesn't strand cards in Error.
  try {
    await ensureSelectOptions({ propName: "Status", optionNames: REQUIRED_STATUSES });
  } catch {
    // ignore
  }

  // If Intake auto-splitting is enabled, ensure the Epic status option exists.
  // Best-effort: only works when Status is a select property.
  if (INTAKE_AUTOSPLIT) {
    try {
      await ensureSelectOptions({ propName: "Status", optionNames: [EPIC_STATUS] });
    } catch {
      // ignore
    }
  }

  // Intake
  const intake = await queryItemsByStatus("Intake");
  const intakeItems = (intake.results ?? []).slice(0, max);
  for (const page of intakeItems) {
    const ok = await handleLlmAction(page, "Intake", async () => processIntake(page));
    if (!ok) break;
  }

  // Ready for Dev
  const ready = await queryItemsByStatus("Ready for Dev");
  const readyItems = (ready.results ?? []).slice(0, max);
  for (const page of readyItems) {
    const ok = await handleLlmAction(page, "Ready for Dev", async () => processReadyForDev(page));
    if (!ok) break;
  }

  // Needs Changes (rerun dev loop on same PR/branch, using Latest Feedback as guidance)
  const needsChanges = await queryItemsByStatus("Needs Changes");
  const needsChangesItems = (needsChanges.results ?? []).slice(0, max);
  for (const page of needsChangesItems) {
    const ok = await handleLlmAction(page, "Needs Changes", async () => processNeedsChanges(page));
    if (!ok) break;
  }

  // In Review (automated PRD-vs-diff review; advances to Ready to Merge or back to Needs Changes)
  const inReview = await queryItemsByStatus("In Review");
  const inReviewItems = (inReview.results ?? []).slice(0, max);
  for (const page of inReviewItems) {
    const ok = await handleLlmAction(page, "In Review", async () => processInReview(page));
    if (!ok) break;
  }

  // Ready to Merge (if PR merged, mark Done)
  const readyToMerge = await queryItemsByStatus("Ready to Merge");
  const readyToMergeItems = (readyToMerge.results ?? []).slice(0, max);
  for (const page of readyToMergeItems) {
    await safeHandle(page, { stage: "Ready to Merge" }, async () => processReadyToMerge(page));
  }

  // Error auto-heal (first-time only per distinct error signature)
  // Goal: fix obvious config/schema issues (e.g., missing Notion Status select options), then move the card back to a recoverable status.
  if (AUTOHEAL_ENABLED) {
    try {
      const errorPages = await queryItemsByStatus("Error");
      const items = (errorPages.results ?? []).slice(0, AUTOHEAL_MAX_ITEMS);

      for (const page of items) {
        const pageId = page.id;
        const title = readTitle(page);
        const lastError = (readRichText(page, "Last Error") || readRichText(page, "Latest Feedback") || "").trim();
        if (!lastError) continue;

        const sig = autohealSig(lastError);
        if (!shouldAttemptAutoheal({ pageId, sig })) continue;

        // Stage context (if the runner recorded it when the error was produced)
        const state = loadAutohealState();
        const stage = state.pages?.[pageId]?.lastStage || "";

        // First: detect unfixable external issues (quota/auth) and avoid thrashing.
        if (looksLikeOpenAiQuotaOrAuth(lastError)) {
          markAutohealAttempt({
            pageId,
            sig,
            result: { applied: false, fix: "blocked_openai_quota_or_auth" },
          });
          console.log(
            `PEREGRINE_AUTOHEAL_APPLIED ${JSON.stringify({ pageId, title, url: notionPageUrl(page), applied: false, errorSig: sig, error: lastError.slice(0, 300), fix: "OpenAI quota/auth issue — cannot auto-fix. Add credits/valid key, then move card out of Error." })}`
          );
          continue;
        }

        // Fix: Notion select schema missing required Status options.
        if (looksLikeNotionMissingSelectOption(lastError)) {
          let fixSummary = "";
          try {
            const res = await ensureSelectOptions({ propName: "Status", optionNames: REQUIRED_STATUSES });
            if (res?.skipped) fixSummary = `ensure Status options: skipped (${res.reason || "unknown"})`;
            else fixSummary = `ensure Status options: added ${res.added ?? "?"}`;
          } catch (e) {
            fixSummary = `ensure Status options failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
          }

          const recovered = inferRecoveredStatus(page, stage);
          try {
            await setLatestFeedback(pageId, `Auto-heal applied: ${fixSummary}. Recovered status: ${recovered}.`);
            await setLastError(pageId, "");
          } catch {
            // ignore
          }

          try {
            await setStatus(pageId, recovered);
          } catch {
            // ignore
          }

          markAutohealAttempt({
            pageId,
            sig,
            result: { applied: true, fix: fixSummary, recoveredStatus: recovered },
          });

          console.log(
            `PEREGRINE_AUTOHEAL_APPLIED ${JSON.stringify({ pageId, title, url: notionPageUrl(page), applied: true, errorSig: sig, error: lastError.slice(0, 300), fix: fixSummary, recoveredStatus: recovered })}`
          );

          continue;
        }

        // Default: mark attempted so we don't spam; no safe automated fix known.
        markAutohealAttempt({ pageId, sig, result: { applied: false, fix: "no_known_safe_fix" } });
        console.log(
          `PEREGRINE_AUTOHEAL_APPLIED ${JSON.stringify({ pageId, title, url: notionPageUrl(page), applied: false, errorSig: sig, error: lastError.slice(0, 300), fix: "No known safe auto-fix for this error. Needs human intervention." })}`
        );
      }
    } catch {
      // ignore
    }
  }

  // Persist work-session LLM action usage (best-effort).
  if (ctl.pageId && sessionActionsUsedDelta > 0) {
    try {
      await updatePage(ctl.pageId, {
        [CONTROL_WORK_SESSION_ACTIONS_USED]: { number: sessionActionsUsedStart + sessionActionsUsedDelta },
      });
    } catch {
      // ignore
    }
  }

  // Note: do NOT commit/push artifacts here.
  // The wrapper (OpenClaw cron script) or GitHub Actions workflow should handle committing run artifacts.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
