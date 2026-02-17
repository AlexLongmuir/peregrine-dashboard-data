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

function npmInstall(dir) {
  if (!fs.existsSync(path.join(dir, "package.json"))) return { skipped: true };
  // Use npm install (not ci) so dependency additions can update lockfiles automatically.
  sh("npm", ["-C", dir, "install", "--no-audit", "--no-fund"], { timeout: 15 * 60 * 1000 });
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

function extractHintsFromText(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();

  const candidates = [];
  const base = [
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
    "revenuecat",
    "mixpanel",
    "supabase",
    "rls",
    "migration",
    "telemetry",
    "analytics",
    "auth",
    "login",
  ];

  for (const kw of base) {
    if (lower.includes(kw)) candidates.push(kw);
  }

  // If the package hints mention specific files/dirs/components, keep those tokens too.
  // (git grep -S uses literal string search; keep these reasonably specific.)
  const fileish = t.match(/[A-Za-z0-9_./-]{4,}/g) || [];
  for (const tok of fileish) {
    if (tok.includes("/") || tok.includes(".")) candidates.push(tok);
  }

  // Also keep a few longer identifier-like tokens.
  const idish = t.match(/[A-Za-z][A-Za-z0-9_-]{6,}/g) || [];
  for (const tok of idish.slice(0, 10)) candidates.push(tok);

  return [...new Set(candidates)].slice(0, 12);
}

function buildAllowedPaths({ dir, repoFiles, hintText, isExcluded }) {
  const hints = extractHintsFromText(hintText);
  const grep = grepSnippets(dir, hints);

  const picked = filePathsFromGrep(grep, 40).filter((p) => repoFiles.includes(p) && !isExcluded(p));

  const lower = String(hintText || "").toLowerCase();
  const regexes = [/^(|.*\/)(landing|benefit|home|welcome)/i];
  if (lower.includes("mixpanel") || lower.includes("telemetry") || lower.includes("analytics")) {
    regexes.push(/mixpanel|telemetry|analytics/i);
  }
  if (lower.includes("supabase") || lower.includes("rls") || lower.includes("migration")) {
    regexes.push(/supabase|migration|rls|schema/i);
  }
  if (lower.includes("auth") || lower.includes("login")) {
    regexes.push(/auth|login|signin|signup/i);
  }
  if (lower.includes("paywall") || lower.includes("revenuecat")) {
    regexes.push(/paywall|revenuecat|iap|subscription/i);
  }

  const byName = repoFiles
    .filter((p) => regexes.some((r) => r.test(p)))
    .filter((p) => !isExcluded(p))
    .slice(0, 80);

  // Broad allowlist (more generous): allow edits across likely code/config files.
  const broad = repoFiles
    .filter((p) => !isExcluded(p))
    .filter(
      (p) =>
        /^(src|app|components|backend|packages|lib|utils|hooks|services|server|client|pages)\//i.test(p) ||
        /\.(ts|tsx|js|jsx|json|css|scss|less|yml|yaml|toml|graphql|gql|sql|prisma|py|go|java|kt|swift|m|mm|h)$/i.test(p)
    )
    .slice(0, 800);

  // Avoid App.tsx unless it appears in grep/name matches.
  const allowedPaths = [...new Set([...picked, ...byName, ...broad])]
    .filter((p) => p !== "App.tsx")
    .slice(0, 250);

  // If we still have nothing, include a minimal set of likely entrypoints (last resort)
  if (allowedPaths.length === 0) {
    const fallback = [
      "app/index.tsx",
      "app/(tabs)/index.tsx",
      "app/(auth)/index.tsx",
      "app/_layout.tsx",
      "app/(tabs)/_layout.tsx",
      "components/BenefitsSection.tsx",
    ].filter((p) => repoFiles.includes(p));
    allowedPaths.push(...fallback);
  }

  return { allowedPaths, hints, grep };
}

function buildCandidateFiles({ dir, allowedPaths, maxFiles = 8 }) {
  const blocks = [];
  for (const rel of allowedPaths.slice(0, maxFiles)) {
    const abs = path.join(dir, rel);
    const c = readFileSafe(abs, 14_000);
    if (c) blocks.push(`## file: ${rel}\n\n${c}`);
  }
  return blocks.join("\n\n");
}

function restoreFiles({ dir, beforeContents }) {
  for (const [rel, content] of Object.entries(beforeContents || {})) {
    const abs = path.join(dir, rel);
    if (content == null) {
      // File did not exist before; best-effort remove if it was created during the failed attempt.
      try {
        fs.unlinkSync(abs);
      } catch {}
      continue;
    }
    fs.writeFileSync(abs, content);
  }
}

function gitDiffNameOnly(dir) {
  return sh("git", ["-C", dir, "diff", "--name-only"]).stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runTypechecks({ dir }) {
  // Keep per-iteration checks lightweight. Full lint/typecheck runs happen at the end.
  runIfScriptExists(dir, "typecheck");

  const backendDir = path.join(dir, "backend");
  if (fs.existsSync(path.join(backendDir, "package.json"))) {
    runIfScriptExists(backendDir, "typecheck");
  }
}

function runFullChecks({ dir }) {
  runIfScriptExists(dir, "lint");
  runIfScriptExists(dir, "typecheck");

  const backendDir = path.join(dir, "backend");
  if (fs.existsSync(path.join(backendDir, "package.json"))) {
    runIfScriptExists(backendDir, "lint");
    runIfScriptExists(backendDir, "typecheck");
  }
}

function normalizePackages(packages, maxPackages) {
  const arr = Array.isArray(packages) ? packages : [];
  return arr.slice(0, maxPackages).map((p, idx) => ({
    name: String(p?.name || `Package ${idx + 1}`),
    goal: String(p?.goal || ""),
    acceptance_criteria_subset: Array.isArray(p?.acceptance_criteria_subset) ? p.acceptance_criteria_subset : [],
    likely_files_areas: Array.isArray(p?.likely_files_areas) ? p.likely_files_areas : [],
    deps: Array.isArray(p?.deps) ? p.deps : [],
    risk: String(p?.risk || ""),
  }));
}

function packageHintText(pkg) {
  const deps = Array.isArray(pkg?.deps) ? pkg.deps.filter(Boolean).map(String) : [];
  return [
    pkg?.name,
    pkg?.goal,
    ...(Array.isArray(pkg?.acceptance_criteria_subset) ? pkg.acceptance_criteria_subset : []),
    ...(Array.isArray(pkg?.likely_files_areas) ? pkg.likely_files_areas : []),
    ...(deps.length ? [`deps: ${deps.join(", ")}`] : []),
    pkg?.risk ? `risk: ${pkg.risk}` : null,
  ]
    .filter(Boolean)
    .map((x) => String(x).trim())
    .filter(Boolean)
    .join("\n");
}

export async function implementFromPrd({
  dir,
  prdBody,
  plan,
  packages = null,
  maxPackages = 10,
  maxIters = 2,
  humanFeedback = "", // optional guidance from Notion "Latest Feedback" when rerunning after Needs Changes
}) {
  // Start from a clean working tree.
  try {
    sh("git", ["-C", dir, "reset", "--hard"]);
  } catch {}

  const repoFiles = listRepoFiles(dir, 3000);

  // IMPORTANT: exclude Peregrine run-docs from the dev agent's editable set.
  const excludedPrefixes = ["docs/peregrine/"];
  const excludedNames = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
  const isExcluded = (p) => excludedNames.has(p) || excludedPrefixes.some((pref) => p.startsWith(pref));

  // Install deps once up front (so per-package typecheck works).
  try {
    installIfPackageJson(dir);
    const backendDir = path.join(dir, "backend");
    if (fs.existsSync(path.join(backendDir, "package.json"))) installIfPackageJson(backendDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Dependency install failed: ${msg}` };
  }

  const pkgs = normalizePackages(packages, maxPackages);
  const usePackages = pkgs.length > 1;

  let lastErr = "";

  const runOnePass = async ({ workPackage = null } = {}) => {
    const hintText = [prdBody, workPackage ? packageHintText(workPackage) : null].filter(Boolean).join("\n\n");

    const { allowedPaths } = buildAllowedPaths({ dir, repoFiles, hintText, isExcluded });
    const candidateFiles = buildCandidateFiles({ dir, allowedPaths, maxFiles: 8 });

    const combinedErr = [humanFeedback, lastErr].filter(Boolean).join("\n\n");

    const edits = await generateEdits({
      prdBody,
      plan,
      allowedPaths,
      repoFiles,
      candidateFiles,
      previousError: combinedErr,
      workPackage,
    });

    const filesToWrite = Array.isArray(edits.files) ? edits.files : [];
    if (filesToWrite.length === 0) {
      return { ok: false, error: "Dev agent produced zero file edits." };
    }

    const toWrite = filesToWrite.slice(0, 5).map((f) => ({
      rel: String(f.path || "").replace(/^\/*/, ""),
      content: String(f.content ?? ""),
    }));

    const invalid = toWrite.find((f) => !f.rel || !allowedPaths.includes(f.rel));
    if (invalid) {
      return { ok: false, error: `Invalid file path from dev agent: ${invalid.rel}` };
    }

    // Must touch at least one non-run-doc file.
    const nonDocTouched = toWrite.some((f) => !f.rel.startsWith("docs/peregrine/"));
    if (!nonDocTouched) {
      return { ok: false, error: "Edits only changed docs/peregrine/. Need actual code changes." };
    }

    const beforeContents = {};
    try {
      const touched = new Set(toWrite.map((x) => x.rel));
      const rootPkgChanged = touched.has("package.json");
      const backendPkgChanged = touched.has("backend/package.json");

      const lockfiles = [
        ...(rootPkgChanged ? ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"] : []),
        ...(backendPkgChanged ? ["backend/package-lock.json", "backend/yarn.lock", "backend/pnpm-lock.yaml"] : []),
      ];

      const snapshot = [...new Set([...toWrite.map((f) => f.rel), ...lockfiles])];
      for (const rel of snapshot) {
        const abs = path.join(dir, rel);
        beforeContents[rel] = readFileSafe(abs, 5_000_000); // effectively full
      }

      for (const f of toWrite) {
        const abs = path.join(dir, f.rel);
        fs.writeFileSync(abs, f.content);
      }

      // If dependencies were changed, update lockfiles automatically.
      if (rootPkgChanged) npmInstall(dir);
      if (backendPkgChanged) npmInstall(path.join(dir, "backend"));

      // Lightweight checks (fail fast).
      await runTypechecks({ dir });

      return { ok: true };
    } catch (e) {
      restoreFiles({ dir, beforeContents });
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Checks failed: ${msg}` };
    }
  };

  if (usePackages) {
    for (const pkg of pkgs) {
      lastErr = "";
      let ok = false;

      for (let i = 0; i < maxIters; i++) {
        const res = await runOnePass({ workPackage: pkg });
        if (res.ok) {
          ok = true;
          break;
        }
        lastErr = res.error || "Package attempt failed";
      }

      if (!ok) {
        return { ok: false, error: `Package "${pkg.name}" failed: ${lastErr || "Failed to generate/apply edits"}` };
      }
    }
  } else {
    // Single-pass implementation.
    for (let i = 0; i < maxIters; i++) {
      // Reset to clean state each attempt
      try {
        sh("git", ["-C", dir, "reset", "--hard"]);
      } catch {}

      const res = await runOnePass({ workPackage: pkgs[0] || null });
      if (res.ok) break;
      lastErr = res.error || "Single-pass attempt failed";

      if (i === maxIters - 1) {
        return { ok: false, error: lastErr || "Failed to generate/apply edits" };
      }
    }
  }

  // Full checks at end.
  try {
    runFullChecks({ dir });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Checks failed: ${msg}` };
  }

  const patch = sh("git", ["-C", dir, "diff"]).stdout;
  const stat = sh("git", ["-C", dir, "diff", "--stat"]).stdout;
  const changedFiles = gitDiffNameOnly(dir);

  return { ok: true, patch, diffStat: stat, changedFiles };
}
