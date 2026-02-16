import fs from "node:fs";
import path from "node:path";

import { sh } from "./util.mjs";
import { generatePatch } from "./openai.mjs";

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function hasScript(pkg, name) {
  return Boolean(pkg?.scripts && typeof pkg.scripts[name] === "string");
}

function runIfScriptExists(dir, script) {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!hasScript(pkg, script)) return { skipped: true };
  sh("npm", ["-C", dir, "run", "-s", script], { timeout: 15 * 60 * 1000 });
  return { skipped: false };
}

function installIfPackageJson(dir) {
  if (!fs.existsSync(path.join(dir, "package.json"))) return { skipped: true };
  sh("npm", ["-C", dir, "ci"], { timeout: 15 * 60 * 1000 });
  return { skipped: false };
}

function listRepoFiles(dir, max = 2000) {
  const { stdout } = sh("git", ["-C", dir, "ls-files"]);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

function grepSnippets(dir, terms, maxLines = 80) {
  const out = [];
  for (const t of terms) {
    if (!t || t.length < 3) continue;
    try {
      const { stdout } = sh("rg", ["-n", "-S", t, dir, "--max-count", "20"], {
        timeout: 20 * 1000,
      });
      if (stdout.trim()) out.push(`## rg: ${t}\n${stdout.trim()}`);
    } catch {
      // ignore missing rg or no matches
    }
  }
  const joined = out.join("\n\n");
  return joined.split("\n").slice(0, maxLines).join("\n");
}

function readFileSafe(p, maxChars = 8000) {
  try {
    const s = fs.readFileSync(p, "utf8");
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + "\n\n[TRUNCATED]\n";
  } catch {
    return null;
  }
}

function extractHintsFromPrd(prdBody) {
  const text = String(prdBody || "");
  // Extremely simple heuristic: pull some nouns from the title/ACs/keywords.
  const candidates = [];
  for (const kw of [
    "landing page",
    "benefit",
    "benefits",
    "copy",
    "text",
    "subtitle",
    "headline",
    "onboarding",
    "settings",
    "paywall",
    "RevenueCat",
    "Mixpanel",
    "Supabase",
  ]) {
    if (text.toLowerCase().includes(kw)) candidates.push(kw);
  }
  return [...new Set(candidates)].slice(0, 8);
}

export async function implementFromPrd({ dir, prdBody, plan, maxIters = 2 }) {
  // Collect repo context
  const files = listRepoFiles(dir, 2000);
  const hints = extractHintsFromPrd(prdBody);
  const grep = grepSnippets(dir, hints);

  // Include a couple likely entrypoints if they exist
  const probePaths = [
    "App.tsx",
    "app/index.tsx",
    "app/(tabs)/index.tsx",
    "app/(auth)/index.tsx",
    "components",
    "app",
    "backend/src",
    "backend/app",
  ];
  const probe = [];
  for (const rel of probePaths) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const c = readFileSafe(abs, 6000);
      if (c) probe.push(`## file: ${rel}\n\n${c}`);
    }
  }

  let lastErr = "";
  for (let i = 0; i < maxIters; i++) {
    const patch = await generatePatch({
      prdBody,
      plan,
      repoFiles: files,
      grepSnippets: grep,
      fileProbes: probe.join("\n\n"),
      previousError: lastErr,
    });

    if (!patch || !patch.includes("diff --git")) {
      lastErr = "Model did not return a unified diff patch.";
      continue;
    }

    const patchPath = path.join(dir, ".peregrine.patch");
    fs.writeFileSync(patchPath, patch);

    try {
      sh("git", ["-C", dir, "apply", "--whitespace=fix", patchPath]);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      continue;
    }

    // Require at least one non-doc change
    const changed = sh("git", ["-C", dir, "diff", "--name-only"]).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const nonDoc = changed.filter((p) => !p.startsWith("docs/peregrine/"));
    if (nonDoc.length === 0) {
      // revert and try again
      sh("git", ["-C", dir, "reset", "--hard"]);
      lastErr = "Patch only changed docs/peregrine/. Need actual code changes.";
      continue;
    }

    // Install deps + run minimal checks
    try {
      installIfPackageJson(dir);
      runIfScriptExists(dir, "lint");
      runIfScriptExists(dir, "typecheck");

      const backendDir = path.join(dir, "backend");
      if (fs.existsSync(path.join(backendDir, "package.json"))) {
        installIfPackageJson(backendDir);
        runIfScriptExists(backendDir, "lint");
        runIfScriptExists(backendDir, "typecheck");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // revert so next iteration has clean tree
      try {
        sh("git", ["-C", dir, "reset", "--hard"]);
      } catch {}
      lastErr = `Checks failed: ${msg}`;
      continue;
    }

    const stat = sh("git", ["-C", dir, "diff", "--stat"]).stdout;
    return { ok: true, patch, diffStat: stat, changedFiles: changed };
  }

  return { ok: false, error: lastErr || "Failed to generate/apply a patch" };
}
