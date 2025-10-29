// sync-github.js
// Standalone job to sync db.json and users.json to GitHub ONLY if changed.
// Usage:
//   node sync-github.js            # normal run
//   node sync-github.js --dry-run  # do not commit, just report
//
// Env vars (same as server.js):
//   GITHUB_OWNER, REPO_NAME, GITHUB_BRANCH (default: main), GITHUB_TOKEN
// Optional: SYNC_FILES="db.json,users.json" to customize targets

import fs from "fs/promises";
import path from "node:path";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME   = process.env.REPO_NAME;
const BRANCH      = process.env.GITHUB_BRANCH || "main";
const TOKEN       = process.env.GITHUB_TOKEN;
const DRY_RUN     = process.argv.includes("--dry-run");

const SYNC_FILES = (process.env.SYNC_FILES || "db.json,users.json")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!GITHUB_OWNER || !REPO_NAME || !TOKEN) {
  console.log("[sync-job] Missing GitHub env (GITHUB_OWNER/REPO_NAME/GITHUB_TOKEN). Skip.");
  process.exit(0);
}

const api = axios.create({
  baseURL: "https://api.github.com",
  headers: {
    Authorization: `token ${TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "request-music-sync-job"
  },
  timeout: 20000
});

async function getRemote(pathInRepo) {
  try {
    const r = await api.get(`/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(pathInRepo)}?ref=${encodeURIComponent(BRANCH)}`);
    const { sha, content } = r.data || {};
    return { sha, contentB64: (content || "").replace(/\n/g, "") };
  } catch (e) {
    if (e.response && e.response.status === 404) return { sha: null, contentB64: null };
    throw e;
  }
}

async function commitIfChanged(localPath, pathInRepo) {
  // read local file
  let localBuf;
  try {
    localBuf = await fs.readFile(path.resolve(process.cwd(), localPath));
  } catch (e) {
    console.log(`[sync-job] ${localPath}: local file not found, skip.`);
    return { changed: false, committed: false, skipped: true };
  }

  // check remote content
  const { sha, contentB64 } = await getRemote(pathInRepo);
  const localB64 = localBuf.toString("base64");
  const same = contentB64 && Buffer.from(contentB64, "base64").equals(localBuf);

  if (same) {
    console.log(`[sync-job] ${pathInRepo}: no changes.`);
    return { changed: false, committed: false, skipped: true };
  }

  if (DRY_RUN) {
    console.log(`[sync-job] ${pathInRepo}: would commit (dry-run).`);
    return { changed: true, committed: false, skipped: false };
  }

  const payload = {
    message: `chore(sync): update ${pathInRepo} at ${new Date().toISOString()}`,
    content: localB64,
    branch: BRANCH,
    ...(sha ? { sha } : {})
  };
  await api.put(`/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(pathInRepo)}`, payload);
  console.log(`[sync-job] ${pathInRepo}: committed.`);
  return { changed: true, committed: true, skipped: false };
}

async function main() {
  console.log(`[sync-job] Start. Repo=${GITHUB_OWNER}/${REPO_NAME} branch=${BRANCH} files=${SYNC_FILES.join(", ")}`);
  let anyChanged = false;
  for (const f of SYNC_FILES) {
    try {
      const r = await commitIfChanged(f, f);
      anyChanged = anyChanged || r.changed;
    } catch (e) {
      console.error(`[sync-job] ${f}: error`, e.message || e);
    }
  }
  console.log(`[sync-job] Done. changed=${anyChanged} dryRun=${DRY_RUN}`);
}

main().catch(e => { console.error("[sync-job] fatal", e); process.exit(1); });
