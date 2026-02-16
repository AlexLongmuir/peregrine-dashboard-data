import fs from "node:fs";
import path from "node:path";

import { sh } from "./util.mjs";
import { generateEdits } from "./openai.mjs";

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

function grepSnippets(dir, terms, maxLines = 160) {
  const out = [];
  for (const t of terms) {
    if (!t || t.length < 3) continue;
    try {
      // Use git grep (more likely installed than ripgrep)
      const { stdout } = sh(
        "git",
        ["-C", dir, "grep", "-n", "-I", "-S", t, "--", "."],
        { timeout: 20 * 1000 }
      );
      if (stdout.trim()) out.push(stdout.trim());
    } catch {
      // ignore no matches
    }
  }
  const joined = out.join("\n");
  return joined.split("\n").slice(0, maxLines).join("\n");
}

function filePathsFromGrep(grepText, max = 8) {
  const paths = [];
  for (const line of String(grepText || "").split("\n")) {
    const m = line.match(/^([^:\n]+):(\d+):/);
    if (m) paths.push(m[1]);
  }
  return [...new Set(paths)].slice(0, max);
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

export async function implementFromPrd({ dir, prdBody, plan, maxIters = 2, humanFeedback = "" }) {  // humanFeedback: optional guidance from Notion "Latest Feedback" when rerunning after Needs Changes

  // Collect repo context
  const files = listRepoFiles(dir, 3000);
  const hints = extractHintsFromPrd(prdBody);
  const grep = grepSnippets(dir, hints);

  const picked = filePathsFromGrep(grep, 20).filter((p) => files.includes(p));

  // Heuristics based on filenames (landing/home/benefit)
  const byName = files
    .filter((p) => /(^|\/)(landing|benefit|home|welcome)/i.test(p))
    .slice(0, 20);

  // Avoid App.tsx unless it appears in grep/name matches.
  const allowedPaths = [...new Set([...picked, ...byName])].filter((p) => p !== "App.tsx").slice(0, 25);

  // If we still have nothing, include a minimal set of likely entrypoints (but last resort)
  if (allowedPaths.length === 0) {
    const fallback = [
      "app/index.tsx",
      "app/(tabs)/index.tsx",
      "app/(auth)/index.tsx",
      "app/_layout.tsx",
      "app/(tabs)/_layout.tsx",
      "components/BenefitsSection.tsx",
    ].filter((p) => files.includes(p));
    allowedPaths.push(...fallback);
  }

  const candidateBlocks = [];
  for (const rel of allowedPaths.slice(0, 8)) {
    const abs = path.join(dir, rel);
    const c = readFileSafe(abs, 14000);
    if (c) candidateBlocks.push(`## file: ${rel}\n\n${c}`);
  }

  const candidateFiles = candidateBlocks.join("\n\n");

  let lastErr = "";
  for (let i = 0; i < maxIters; i++) {
    // Reset to clean state each attempt
    try {
      sh("git", ["-C", dir, "reset", "--hard"]);
    } catch {}

    const combinedErr = [humanFeedback, lastErr].filter(Boolean).join("\n\n");

    const edits = await generateEdits({
      prdBody,
      plan,
      allowedPaths,
      repoFiles: files,
      candidateFiles,
      previousError: combinedErr,
    });

    const filesToWrite = Array.isArray(edits.files) ? edits.files : [];
    if (filesToWrite.length === 0) {
      lastErr = "Dev agent produced zero file edits.";
      continue;
    }

    // Validate + write (all-or-nothing)
    const toWrite = filesToWrite.slice(0, 5).map((f) => ({
      rel: String(f.path || "").replace(/^\/*/, ""),
      content: String(f.content ?? ""),
    }));

    const invalid = toWrite.find((f) => !f.rel || !allowedPaths.includes(f.rel));
    if (invalid) {
      lastErr = `Invalid file path from dev agent: ${invalid.rel}`;
      continue;
    }

    for (const f of toWrite) {
      const abs = path.join(dir, f.rel);
      fs.writeFileSync(abs, f.content);
    }

    const changed = sh("git", ["-C", dir, "diff", "--name-only"]).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const nonDoc = changed.filter((p) => !p.startsWith("docs/peregrine/"));
    if (nonDoc.length === 0) {
      lastErr = "Edits only changed docs/peregrine/. Need actual code changes.";
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
      lastErr = `Checks failed: ${msg}`;
      continue;
    }

    const patch = sh("git", ["-C", dir, "diff"]).stdout;
    const stat = sh("git", ["-C", dir, "diff", "--stat"]).stdout;

    return { ok: true, patch, diffStat: stat, changedFiles: changed };
  }

  return { ok: false, error: lastErr || "Failed to generate/apply edits" };
}
