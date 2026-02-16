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

export async function cloneRepo({ repo, dir, token }) {
  const { owner, repo: name } = parseRepo(repo);
  const t = token ?? (await getInstallationToken());
  const url = `https://x-access-token:${t}@github.com/${owner}/${name}.git`;
  sh("git", ["clone", "--depth", "1", url, dir]);
}

export function gitConfigUser({ dir }) {
  sh("git", ["-C", dir, "config", "user.email", "peregrine-bot@users.noreply.github.com"]);
  sh("git", ["-C", dir, "config", "user.name", "peregrine-bot"]);
}

export function gitCheckoutNewBranch({ dir, branch }) {
  sh("git", ["-C", dir, "checkout", "-b", branch]);
}

export function gitFetchBranch({ dir, branch }) {
  sh("git", ["-C", dir, "fetch", "origin", `${branch}:${branch}`]);
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
