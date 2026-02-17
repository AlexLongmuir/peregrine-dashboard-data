#!/usr/bin/env node

const lines = [
  "Peregrine runner (in peregrine-dashboard-data)",
  "",
  "Required env (runner):",
  "  NOTION_TOKEN",
  "  NOTION_DATA_SOURCE_ID   (for querying items)",
  "  NOTION_DATABASE_ID      (for creating/updating pages; Notion 'database' object id)",
  "  GITHUB_APP_ID",
  "  GITHUB_APP_PRIVATE_KEY  (PEM; newlines allowed or escaped as \\n)",
  "  GITHUB_APP_INSTALLATION_ID",
  "  OPENAI_API_KEY          (optional but required for PRD/dev/review agents)",
  "",
  "Optional env:",
  "  PEREGRINE_MAX_ITEMS            (default 10)",
  "  PEREGRINE_REDACT_ARTIFACTS     (default true)",
  "  OPENAI_MODEL_PRD               (default gpt-4.1)",
  "  OPENAI_MODEL_DEV               (default gpt-4.1)",
  "  OPENAI_MODEL_REVIEW            (default gpt-4.1)",
  "",
  "Notion properties expected:",
  "  Name (title)",
  "  Rough Draft (rich text)",
  "  Target Repo (select) (select)  e.g. AlexLongmuir/regretless-3",
  "  Status (select)           Intake | PRD Drafted | Ready for Dev | In Dev | In Review | Needs Changes | Ready to Merge | Done | Error",
  "  GitHub Issue (url)",
  "  GitHub PR (url)",
  "  Run ID (rich text)",
  "  Latest Feedback (rich text)",
  "  Last Error (rich text)",
];

console.log(lines.join("\n"));
