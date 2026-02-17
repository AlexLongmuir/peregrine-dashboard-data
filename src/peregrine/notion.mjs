/**
 * Notion API helpers for Peregrine workflow.
 *
 * Required env: NOTION_TOKEN, NOTION_DATA_SOURCE_ID, NOTION_DATABASE_ID
 */

import { requireEnv, intEnv } from "./util.mjs";

const NOTION_VERSION = "2025-09-03";

function headers() {
  return {
    Authorization: `Bearer ${requireEnv("NOTION_TOKEN")}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Notion ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

// ─── Query items from the Kanban board ────────────────────────────────

function buildStatusFilter(kind, op, value) {
  if (kind === "select") return { property: "Status", select: { [op]: value } };
  if (kind === "status") return { property: "Status", status: { [op]: value } };
  throw new Error(`Unsupported Status kind: ${kind}`);
}

async function queryWithStatusKind(dsId, kind, filter, max) {
  return notionFetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
    method: "POST",
    body: JSON.stringify({ filter, page_size: max }),
  });
}

export async function getDataSource() {
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  return notionFetch(`https://api.notion.com/v1/data_sources/${dsId.replace(/-/g, "")}`);
}

export async function patchDataSource(properties) {
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  return notionFetch(`https://api.notion.com/v1/data_sources/${dsId.replace(/-/g, "")}`,
    {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    }
  );
}

export async function ensureSelectOptions({ propName, optionNames }) {
  const ds = await getDataSource();
  const prop = ds.properties?.[propName];
  if (!prop || prop.type !== "select") return { skipped: true, reason: "missing_or_not_select" };

  const existing = Array.isArray(prop.select?.options) ? prop.select.options : [];
  const byName = new Map(existing.map((o) => [o.name, o]));

  let changed = false;
  for (const name of optionNames || []) {
    const n = String(name || "").trim();
    if (!n) continue;
    if (!byName.has(n)) {
      byName.set(n, { name: n, color: "default" });
      changed = true;
    }
  }

  if (!changed) return { skipped: true, reason: "no_changes" };

  const merged = Array.from(byName.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  await patchDataSource({
    [propName]: { select: { options: merged } },
  });

  return { skipped: false, added: merged.length - existing.length };
}

export async function ensureProperties(defs = []) {
  const ds = await getDataSource();
  const existing = ds.properties || {};

  const patch = {};
  const added = [];

  for (const def of defs || []) {
    const name = String(def?.name || "").trim();
    const type = String(def?.type || "").trim();
    if (!name || !type) continue;
    if (existing[name]) continue;

    const schema = def?.schema && typeof def.schema === "object" ? def.schema : {};
    patch[name] = { [type]: schema };
    added.push(name);
  }

  if (added.length === 0) return { skipped: true, reason: "no_changes", added: [] };

  await patchDataSource(patch);
  return { skipped: false, added };
}

export async function queryItemsByStatus(status) {
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  const max = intEnv("PEREGRINE_MAX_ITEMS", 10);

  // Try select first (works for select-based Kanban), then fallback to status.
  try {
    return await queryWithStatusKind(dsId, "select", buildStatusFilter("select", "equals", status), max);
  } catch (e) {
    return await queryWithStatusKind(dsId, "status", buildStatusFilter("status", "equals", status), max);
  }
}

export async function queryAllActive() {
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  const max = intEnv("PEREGRINE_MAX_ITEMS", 10);

  try {
    return await queryWithStatusKind(
      dsId,
      "select",
      {
        and: [buildStatusFilter("select", "does_not_equal", "Done"), buildStatusFilter("select", "does_not_equal", "Error")],
      },
      max
    );
  } catch (e) {
    return await queryWithStatusKind(
      dsId,
      "status",
      {
        and: [buildStatusFilter("status", "does_not_equal", "Done"), buildStatusFilter("status", "does_not_equal", "Error")],
      },
      max
    );
  }
}

export async function queryItemsByName(name) {
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  const max = intEnv("PEREGRINE_MAX_ITEMS", 10);

  return notionFetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: "Name", title: { equals: String(name || "") } },
      page_size: max,
    }),
  });
}

// Generic query helper (useful for PM / team-mode tooling)
export async function queryItems({ filter = null, max = null } = {}) {
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  const pageSize = max ?? intEnv("PEREGRINE_MAX_ITEMS", 10);

  return notionFetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
    method: "POST",
    body: JSON.stringify({
      ...(filter ? { filter } : {}),
      page_size: pageSize,
    }),
  });
}

// ─── Read properties from a page ──────────────────────────────────────

export function readTitle(page) {
  const p = page.properties?.Name;
  if (!p) return "";
  return (p.title ?? []).map((t) => t.plain_text ?? "").join("");
}

export function readRichText(page, prop) {
  const p = page.properties?.[prop];
  if (!p) return "";
  return (p.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
}

export function readSelect(page, prop) {
  return page.properties?.[prop]?.select?.name ?? "";
}

export function readUrl(page, prop) {
  return page.properties?.[prop]?.url ?? "";
}

export function readCheckbox(page, prop) {
  return Boolean(page.properties?.[prop]?.checkbox);
}

export function readNumber(page, prop) {
  const n = page.properties?.[prop]?.number;
  return typeof n === "number" ? n : null;
}

export function readDateStart(page, prop) {
  return page.properties?.[prop]?.date?.start ?? "";
}

export function readRelationIds(page, prop) {
  const rel = page.properties?.[prop]?.relation;
  if (!Array.isArray(rel)) return [];
  return rel.map((r) => r?.id).filter(Boolean);
}

// Target repo helper (supports both legacy rich_text and new dropdown select)
export function readTargetRepo(page) {
  const fromSelect = readSelect(page, "Target Repo (select)") || readSelect(page, "Target Repo");
  const fromText = readRichText(page, "Target Repo");
  return String(fromSelect || fromText || "").trim();
}

// ─── Update page properties ───────────────────────────────────────────

export async function updatePage(pageId, properties) {
  return notionFetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

export async function setStatus(pageId, status) {
  try {
    return await updatePage(pageId, { Status: { select: { name: status } } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Only fall back when the database uses a Status (status) property.
    if (!msg.includes("Status is expected to be status")) throw e;
    return await updatePage(pageId, { Status: { status: { name: status } } });
  }
}

export async function setGitHubIssue(pageId, url) {
  return updatePage(pageId, { "GitHub Issue": { url } });
}

export async function setGitHubPR(pageId, url) {
  return updatePage(pageId, { "GitHub PR": { url } });
}

export async function setRunId(pageId, runId) {
  return updatePage(pageId, {
    "Run ID": { rich_text: [{ text: { content: runId.slice(0, 2000) } }] },
  });
}

export async function setLatestFeedback(pageId, text) {
  return updatePage(pageId, {
    "Latest Feedback": { rich_text: [{ text: { content: (text ?? "").slice(0, 2000) } }] },
  });
}

export async function setLastError(pageId, text) {
  return updatePage(pageId, {
    "Last Error": { rich_text: [{ text: { content: (text ?? "").slice(0, 2000) } }] },
  });
}

export async function setRelation(pageId, prop, pageIds) {
  return updatePage(pageId, {
    [prop]: { relation: (pageIds || []).map((id) => ({ id })) },
  });
}

// ─── Create a page (new Kanban card) ──────────────────────────────────

export async function createCard({ title, roughDraft, targetRepo, status = "Intake", extraProperties = {} }) {
  const dbId = requireEnv("NOTION_DATABASE_ID");

  // Avoid writing to removed legacy properties.
  // Prefer the dropdown property ("Target Repo (select)") if present, otherwise fall back gracefully.
  let ds = null;
  try {
    ds = await getDataSource();
  } catch {
    // ignore; we'll fall back to best-effort property names
  }

  const dsProps = ds?.properties ?? {};
  const statusKind = dsProps?.Status?.type === "status" ? "status" : "select";

  const targetRepoProp =
    dsProps["Target Repo (select)"]?.type === "select"
      ? { name: "Target Repo (select)", type: "select" }
      : dsProps["Target Repo"]?.type === "select"
        ? { name: "Target Repo", type: "select" }
        : dsProps["Target Repo"]?.type === "rich_text"
          ? { name: "Target Repo", type: "rich_text" }
          : null;

  const properties = {
    Name: { title: [{ text: { content: String(title || "").slice(0, 250) } }] },
    "Rough Draft": { rich_text: [{ text: { content: String(roughDraft || "").slice(0, 2000) } }] },
    ...(targetRepo && targetRepoProp
      ? {
          [targetRepoProp.name]:
            targetRepoProp.type === "select"
              ? { select: { name: String(targetRepo) } }
              : { rich_text: [{ text: { content: String(targetRepo).slice(0, 2000) } }] },
        }
      : {}),
    Status: statusKind === "status" ? { status: { name: status } } : { select: { name: status } },
    ...extraProperties,
  };

  return notionFetch("https://api.notion.com/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties,
    }),
  });
}
