/**
 * GitHub API + git helpers using a GitHub App installation token.
 *
 * Required env:
 *  GITHUB_APP_ID
 *  GITHUB_APP_PRIVATE_KEY
 *  GITHUB_APP_INSTALLATION_ID
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { requireEnv, sh } from "./util.mjs";

export function parseRepo(str) {
  const [owner, repo] = String(str || "").split("/");
  if (!owner || !repo) throw new Error(`Invalid repo string: ${str}`);
  return { owner, repo };
}

export function getOctokit() {
  const appId = requireEnv("GITHUB_APP_ID");
  const installationId = requireEnv("GITHUB_APP_INSTALLATION_ID");
  let privateKey = requireEnv("GITHUB_APP_PRIVATE_KEY");

  // Support escaped newlines.
  if (privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");

  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
  });
}

export async function getInstallationToken() {
  const appId = requireEnv("GITHUB_APP_ID");
  const installationId = requireEnv("GITHUB_APP_INSTALLATION_ID");
  let privateKey = requireEnv("GITHUB_APP_PRIVATE_KEY");
  if (privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");

  const auth = createAppAuth({ appId, installationId, privateKey });
  const token = await auth({ type: "installation" });
  return token.token;
}

export async function createIssue({ repo, title, body }) {
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();

  const res = await octokit.request("POST /repos/{owner}/{repo}/issues", {
    owner,
    repo: name,
    title,
    body,
  });

  return res.data; // includes html_url, number
}

export async function updateIssueBody({ repo, issueNumber, body, title }) {
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();

  const res = await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
    owner,
    repo: name,
    issue_number: issueNumber,
    ...(title ? { title } : {}),
    body,
  });

  return res.data;
}

export async function getIssue({ repo, issueNumber }) {
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();
  const res = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner,
    repo: name,
    issue_number: issueNumber,
  });
  return res.data;
}

export async function createPullRequest({ repo, head, base = "main", title, body }) {
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();

  const res = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner,
    repo: name,
    head,
    base,
    title,
    body,
  });

  return res.data; // html_url, number
}

export async function getPullRequest({ repo, prNumber }) {
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();
  const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo: name,
    pull_number: prNumber,
  });
  return res.data;
}

export async function mergePullRequest({ repo, prNumber, mergeMethod = "squash", commitTitle, commitMessage } = {}) {
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();
  const res = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    owner,
    repo: name,
    pull_number: prNumber,
    merge_method: mergeMethod,
    ...(commitTitle ? { commit_title: commitTitle } : {}),
    ...(commitMessage ? { commit_message: commitMessage } : {}),
  });
  return res.data; // merged, message, sha
}

export async function updatePullRequest({ repo, prNumber, title, body }) {
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();
  const res = await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo: name,
    pull_number: prNumber,
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
  });
  return res.data;
}

export async function commentOnIssue({ repo, issueNumber, body }) {
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();
  const res = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo: name,
    issue_number: issueNumber,
    body,
  });
  return res.data;
}

export async function listInstallationRepos({ perPage = 100 } = {}) {
  const octokit = getOctokit();
  const res = await octokit.request("GET /installation/repositories", { per_page: perPage });
  return (res.data.repositories || []).map((r) => r.full_name).filter(Boolean);
}

export async function listCheckRunsForRef({ repo, ref, filter = "latest", perPage = 100 } = {}) {
  if (!repo || !ref) throw new Error("listCheckRunsForRef missing repo/ref");
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();

  const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
    owner,
    repo: name,
    ref,
    filter,
    per_page: perPage,
  });

  return res.data; // { total_count, check_runs: [...] }
}

export async function getCommitStatus({ repo, ref } = {}) {
  if (!repo || !ref) throw new Error("getCommitStatus missing repo/ref");
  const { owner, repo: name } = parseRepo(repo);
  const octokit = getOctokit();

  const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
    owner,
    repo: name,
    ref,
  });

  return res.data; // { state, statuses: [...] }
}

function repoHttpsUrl({ repo, token }) {
  const { owner, repo: name } = parseRepo(repo);
  if (!token) return `https://github.com/${owner}/${name}.git`;
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

export async function ensureOriginToken({ dir, repo, token } = {}) {
  if (!dir || !repo) return { skipped: true };
  const t = token ?? (await getInstallationToken());
  const url = repoHttpsUrl({ repo, token: t });
  sh("git", ["-C", dir, "remote", "set-url", "origin", url]);
  return { skipped: false, token: t };
}

export async function cloneRepo({ repo, dir, token }) {
  const t = token ?? (await getInstallationToken());
  const url = repoHttpsUrl({ repo, token: t });
  sh("git", ["clone", "--depth", "1", url, dir]);
}

export function gitConfigUser({ dir }) {
  sh("git", ["-C", dir, "config", "user.email", "peregrine-bot@users.noreply.github.com"]);
  sh("git", ["-C", dir, "config", "user.name", "peregrine-bot"]);
}

export function gitCheckoutNewBranch({ dir, branch }) {
  sh("git", ["-C", dir, "checkout", "-b", branch]);
}

export async function gitFetchBranch({ dir, branch, repo, token } = {}) {
  if (!dir || !branch) throw new Error(`gitFetchBranch missing dir/branch`);

  // Some environments strip credentials or have a stale token; always refresh origin URL when we know the repo.
  if (repo) await ensureOriginToken({ dir, repo, token });

  try {
    sh("git", ["-C", dir, "fetch", "origin", `${branch}:${branch}`]);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? (e.stderr || e.message || "") : String(e);
    // Retry once with a fresh installation token on 401s.
    if (repo && msg.includes("HTTP 401")) {
      await ensureOriginToken({ dir, repo });
      sh("git", ["-C", dir, "fetch", "origin", `${branch}:${branch}`]);
      return { ok: true, retried: true };
    }
    throw e;
  }
}

export function gitCheckoutBranch({ dir, branch }) {
  sh("git", ["-C", dir, "checkout", branch]);
}

export function gitCommitAll({ dir, message }) {
  sh("git", ["-C", dir, "add", "-A"]);
  // allow empty commits sometimes for scaffolding
  sh("git", ["-C", dir, "commit", "--allow-empty", "-m", message]);
}

export async function gitPush({ dir, branch, token, repo }) {
  const t = token ?? (await getInstallationToken());
  // Ensure remote uses token.
  if (repo) {
    const { owner, repo: name } = parseRepo(repo);
    const url = `https://x-access-token:${t}@github.com/${owner}/${name}.git`;
    sh("git", ["-C", dir, "remote", "set-url", "origin", url]);
  }
  sh("git", ["-C", dir, "push", "-u", "origin", branch]);
}
