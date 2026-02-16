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

let _statusType = null;
async function getStatusType() {
  if (_statusType) return _statusType;
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  const ds = await notionFetch(`https://api.notion.com/v1/data_sources/${dsId}`);
  const t = ds?.properties?.Status?.type;
  if (!t) throw new Error("Could not determine Notion Status property type");
  _statusType = t; // 'select' or 'status'
  return _statusType;
}

function statusFilter(type, op, value) {
  if (type === "select") return { property: "Status", select: { [op]: value } };
  if (type === "status") return { property: "Status", status: { [op]: value } };
  throw new Error(`Unsupported Status property type: ${type}`);
}

export async function queryItemsByStatus(status) {
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  const max = intEnv("PEREGRINE_MAX_ITEMS", 10);
  const type = await getStatusType();
  return notionFetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: statusFilter(type, "equals", status),
      page_size: max,
    }),
  });
}

export async function queryAllActive() {
  const dsId = requireEnv("NOTION_DATA_SOURCE_ID");
  const max = intEnv("PEREGRINE_MAX_ITEMS", 10);
  const type = await getStatusType();
  // Get everything that isn't "Done" or "Error"
  return notionFetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        and: [statusFilter(type, "does_not_equal", "Done"), statusFilter(type, "does_not_equal", "Error")],
      },
      page_size: max,
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

// ─── Update page properties ───────────────────────────────────────────

export async function updatePage(pageId, properties) {
  return notionFetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

export async function setStatus(pageId, status) {
  const type = await getStatusType();
  if (type === "select") return updatePage(pageId, { Status: { select: { name: status } } });
  if (type === "status") return updatePage(pageId, { Status: { status: { name: status } } });
  throw new Error(`Unsupported Status property type: ${type}`);
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

// ─── Create a page (new Kanban card) ──────────────────────────────────

export async function createCard({ title, roughDraft, targetRepo, status = "Intake" }) {
  const dbId = requireEnv("NOTION_DATABASE_ID");
  const type = await getStatusType();
  const statusProp = type === "select" ? { select: { name: status } } : { status: { name: status } };

  return notionFetch("https://api.notion.com/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: {
        Name: { title: [{ text: { content: title } }] },
        "Rough Draft": { rich_text: [{ text: { content: roughDraft.slice(0, 2000) } }] },
        "Target Repo": { rich_text: [{ text: { content: targetRepo } }] },
        Status: statusProp,
      },
    }),
  });
}
