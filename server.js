import express from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { JSONFilePreset } from "lowdb/node";
import { nanoid } from "nanoid";
import fetch from "node-fetch";
import cron from "node-cron";
import axios from "axios";
import dotenv from "dotenv";
import path from "node:path";
import url from "node:url";
dotenv.config();

const app = express();

app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

// ==== GitHub 同期設定 ====
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ==== LowDB ====
const db = await JSONFilePreset("db.json", {
  responses: [],
  songCounts: {},
  settings: {
    recruiting: true,
    reason: "",
    frontendTitle: "♬曲をリクエストする",
    adminPassword: "housou0401",
    playerControlsEnabled: true,
    monthlyTokens: 5,
    maintenance: false,
    rateLimitPerMin: 5,
    duplicateCooldownMinutes: 15,
  },
});
const usersDb = await JSONFilePreset("users.json", {
  users: [], // { id, username, deviceInfo, role('user'|'admin'), tokens(null|number), lastRefillISO('YYYY-MM') }
});

// ==== Middleware ====
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// 静的配信 & ルート
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
app.use(express.static("public"));
app.get("/", async (_req, res) => {
  try {
    const filePath = path.join(__dirname, "index.html");
    const fs = await import("node:fs/promises");
    let html = await fs.readFile(filePath, "utf8");
    const bridge = `
<style id="mypage-bridge-style">
  .mypage-link{position:fixed;top:12px;right:12px;display:inline-flex;gap:8px;align-items:center;background:#111827;color:#fff;text-decoration:none;padding:8px 12px;border-radius:999px;border:1px solid #374151;box-shadow:0 6px 16px rgba(0,0,0,.25);z-index:9999;font-size:14px}
  .mypage-link img{width:20px;height:20px;border-radius:50%;object-fit:cover}
  @media (max-width:520px){.mypage-link{top:12px;right:12px;padding:8px 12px}}
</style>
<script id="mypage-bridge">
(function(){
  function insert(){
    if (document.getElementById("mypage-link")) return;
    var a = document.createElement("a");
    a.id = "mypage-link";
    a.href = "/mypage";
    a.className = "mypage-link";
    var img = new Image();
    img.src = "/img/mypage.png"; // 画像は public/img/mypage.png に置いてください
    img.alt = "マイページ";
    a.appendChild(img);
    var span = document.createElement("span");
    span.textContent = "マイページ";
    a.appendChild(span);
    document.body.appendChild(a);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", insert);
  else insert();
})();
</script>`;
    if (html.includes("</body>")) html = html.replace("</body>", bridge + "
</body>");
    else html += bridge;
    res.set("Content-Type","text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("mypage bridge send error:", e);
    res.sendFile(path.join(__dirname, "index.html"));
  }
});
// ==== Helpers ====
const monthKey = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const isAdmin = (u) => u && u.role === "admin";
const getUserById = (id) => usersDb.data.users.find((u) => u.id === id);
const deviceInfoFromReq = (req) => ({
  ua: req.get("User-Agent") || "",
  ip: req.ip || req.connection?.remoteAddress || "",
});

const COOKIE_OPTS = { httpOnly: true, sameSite: "Lax", maxAge: 1000 * 60 * 60 * 24 * 365 };
const getInt = (v) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : 0);
const getRegFails = (req) => Math.max(0, getInt(req.cookies?.areg));
const setRegFails = (res, n) => res.cookie("areg", Math.max(0, n), COOKIE_OPTS);
const getLoginFails = (req) => Math.max(0, getInt(req.cookies?.alog));
const setLoginFails = (res, n) => res.cookie("alog", Math.max(0, n), COOKIE_OPTS);
const MAX_TRIES = 3;

// ---- レート制限（メモリ） ----
const rateMap = new Map(); // key: userId, value: number[] timestamps(ms)
function hitRate(userId, limitPerMin) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const arr = rateMap.get(userId) || [];
  const pruned = arr.filter(ts => now - ts < windowMs);
  pruned.push(now);
  rateMap.set(userId, pruned);
  return pruned.length <= limitPerMin;
}

// 月次トークン配布
async function ensureMonthlyRefill(user) {
  if (!user || isAdmin(user)) return;
  const m = monthKey();
  const monthly = Number(db.data.settings.monthlyTokens ?? 5);
  if (user.lastRefillISO !== m) {
    user.tokens = monthly;
    user.lastRefillISO = m;
    await usersDb.write();
  }
}
async function refillAllIfMonthChanged() {
  const m = monthKey();
  const monthly = Number(db.data.settings.monthlyTokens ?? 5);
  let touched = false;
  for (const u of usersDb.data.users) {
    if (!isAdmin(u) && u.lastRefillISO !== m) {
      u.tokens = monthly;
      u.lastRefillISO = m;
      touched = true;
    }
  }
  if (touched) await usersDb.write();
}

// Cookie → user / adminSession / impersonation
app.use(async (req, _res, next) => {
  const baseDeviceId = req.cookies?.deviceId || null;
  const baseUser = baseDeviceId ? getUserById(baseDeviceId) : null;

  // admin セッションは「adminユーザー」または「adminAuthクッキー」で判定
  const adminSession = (baseUser && isAdmin(baseUser)) || (req.cookies?.adminAuth === "1");

  // なりすまし
  let effectiveUser = baseUser;
  let impersonating = false;
  const impId = req.cookies?.impersonateId;
  if (impId && adminSession) {
    const target = getUserById(impId);
    if (target) { effectiveUser = target; impersonating = true; }
  }

  if (effectiveUser) await ensureMonthlyRefill(effectiveUser);

  req.user = effectiveUser || null;
  req.adminSession = !!adminSession;
  req.impersonating = impersonating;
  next();
});

// 管理者保護
function requireAdmin(req, res, next) {
  if (req.adminSession) return next();
  return res
    .status(403)
    .send(`<!doctype html><meta charset="utf-8"><title>403</title><p>管理者のみアクセスできます。</p><p><a href="/">トップへ</a></p>`);
}

// ==========================
// Apple Music 検索（再編成）
// ==========================

// 共通：iTunes Search API 呼び出し（言語判定は廃止）
async function itunesSearch(params) {
  const qs = new URLSearchParams({ country: "JP", media: "music", limit: "75", ...params });
  const urlStr = `https://itunes.apple.com/search?${qs.toString()}`;
  const resp = await fetch(urlStr, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) return { results: [] };
  const text = await resp.text();
  if (!text.trim()) return { results: [] };
  try { return JSON.parse(text); } catch { return { results: [] }; }
}

// アーティストの楽曲一覧（lookup）
async function itunesLookupSongsByArtist(artistId) {
  const urlStr = `https://itunes.apple.com/lookup?id=${artistId}&entity=song&country=JP&limit=100`;
  const r = await fetch(urlStr, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return [];
  const text = await r.text();
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text);
    if (!data.results || data.results.length <= 1) return [];
    return data.results.slice(1).map(normalizeSong);
  } catch { return []; }
}

// 結果の標準化
function normalizeSong(x) {
  let artwork = x.artworkUrl100 || x.artworkUrl60 || "";
  if (artwork) artwork = artwork.replace(/\/[0-9]+x[0-9]+bb\.jpg$/, "/300x300bb.jpg");
  return {
    trackName: x.trackName,
    artistName: x.artistName,
    trackViewUrl: x.trackViewUrl,
    artworkUrl: artwork,
    previewUrl: x.previewUrl || "",
    releaseDate: x.releaseDate || ""
  };
}

// 並び替えキー取得（クッキー or クエリ）
function getSearchSort(req) {
  const key = (req.query.sort || req.cookies?.searchSort || "relevance").toString();
  const allowed = new Set(["relevance", "release_desc", "release_asc", "name_asc", "artist_asc"]);
  return allowed.has(key) ? key : "relevance";
}
function sortSongs(list, sortKey) {
  if (!Array.isArray(list) || list.length === 0) return list;
  const arr = [...list];
  switch (sortKey) {
    case "release_desc":
      arr.sort((a,b)=> new Date(b.releaseDate||0) - new Date(a.releaseDate||0) || (a.trackName||"").localeCompare(b.trackName||""));
      break;
    case "release_asc":
      arr.sort((a,b)=> new Date(a.releaseDate||0) - new Date(b.releaseDate||0) || (a.trackName||"").localeCompare(b.trackName||""));
      break;
    case "name_asc":
      arr.sort((a,b)=> (a.trackName||"").localeCompare(b.trackName||"") || (a.artistName||"").localeCompare(b.artistName||""));
      break;
    case "artist_asc":
      arr.sort((a,b)=> (a.artistName||"").localeCompare(b.artistName||"") || (a.trackName||"").localeCompare(b.trackName||""));
      break;
    case "relevance":
    default:
      break;
  }
  return arr;
}
function sortArtists(artists, sortKey) {
  if (!Array.isArray(artists) || artists.length === 0) return artists;
  const arr = [...artists];
  if (sortKey === "artist_asc" || sortKey === "name_asc") {
    arr.sort((a,b)=> (a.artistName||"").localeCompare(b.artistName||""));
  }
  return arr;
}

// ==== 検索 API ====
app.get("/search", async (req, res) => {
  try {
    const mode = (req.query.mode || "song").toString();
    const sortKey = getSearchSort(req);

    if (mode === "artist") {
      if (req.query.artistId) {
        const tracks = await itunesLookupSongsByArtist(req.query.artistId.toString().trim());
        return res.json(sortSongs(tracks, sortKey));
      }
      const q = (req.query.query || "").toString().trim();
      if (!q) return res.json([]);
      const data = await itunesSearch({ term: q, entity: "album" });
      const artistMap = new Map();
      for (const a of (data.results || [])) {
        if (!a.artistId || !a.artistName) continue;
        if (!artistMap.has(a.artistId)) {
          let artwork = a.artworkUrl100 || a.artworkUrl60 || "";
          if (artwork) artwork = artwork.replace(/\/[0-9]+x[0-9]+bb\.jpg$/, "/300x300bb.jpg");
          artistMap.set(a.artistId, {
            trackName: a.artistName,
            artistName: a.artistName,
            artworkUrl: artwork,
            artistId: a.artistId
          });
        }
      }
      return res.json(sortArtists([...artistMap.values()], sortKey));
    }

    // mode=song
    const q = (req.query.query || "").toString().trim();
    if (!q) return res.json([]);
    const artist = (req.query.artist || "").toString().trim();
    const term = artist ? `${q} ${artist}` : q;
    const data = await itunesSearch({ term, entity: "song" });

    const seen = new Set();
    const songs = [];
    for (const t of data.results || []) {
      if (!t.trackName || !t.artistName) continue;
      const key = (t.trackName + "|" + t.artistName).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      songs.push(normalizeSong(t));
    }
    return res.json(sortSongs(songs, sortKey));
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

// ==== 認証状態 ====
app.get("/auth/status", (req, res) => {
  const regRem = Math.max(0, MAX_TRIES - getRegFails(req));
  const logRem = Math.max(0, MAX_TRIES - getLoginFails(req));

  const u = req.user;
  const name = u?.username || null;
  const role = u?.role || null;
  const roleName = role === "admin" ? "管理者" : "ユーザ";

  let notify = null;
  let welcome = null;
  let adminNote = null;

  if (req.cookies && req.cookies.justLoggedIn === "1" && name) {
    notify = `${roleName}としてログインしました。 ${name} さん、ようこそ！`;
    if (role === "admin") adminNote = "あなたは管理者としてログイン中です。";
    res.clearCookie("justLoggedIn");
  } else if (name) {
    welcome = `${name} さん、ようこそ！`;
    if (role === "admin") adminNote = "あなたは管理者としてログイン中です。";
  }

  res.json({ adminRegRemaining: regRem, adminLoginRemaining: logRem, notify, welcome, adminNote });
});
// ==== 登録 ====
app.post("/register", async (req, res) => {
  try {
    const usernameRaw = (req.body.username ?? "").toString();
    const username = usernameRaw.trim() || "Guest";
    const adminPassword = typeof req.body.adminPassword === "string" ? req.body.adminPassword.trim() : "";
    const monthly = Number(db.data.settings.monthlyTokens ?? 5);

    const regFails = getRegFails(req);
    if (adminPassword) {
      if (regFails >= MAX_TRIES) {
        return res.json({ ok: false, reason: "locked", remaining: 0, message: "管理者パスワードの試行上限に達しました。" });
      }
      if (adminPassword !== db.data.settings.adminPassword) {
        const n = regFails + 1;
        setRegFails(res, n);
        return res.json({ ok: false, reason: "bad_admin_password", remaining: Math.max(0, MAX_TRIES - n) });
      }
    }

    const deviceId = nanoid(16);
    const role = adminPassword ? "admin" : "user";
    usersDb.data.users.push({
      id: deviceId,
      username,
      deviceInfo: deviceInfoFromReq(req),
      role,
      tokens: role === "admin" ? null : monthly,
      lastRefillISO: monthKey(),
    });
    await usersDb.write();

    setRegFails(res, 0);
    res.cookie("deviceId", deviceId, COOKIE_OPTS);
    res.cookie("justLoggedIn","1",COOKIE_OPTS);
    if (role === "admin") res.cookie("adminAuth", "1", COOKIE_OPTS);
    res.json({ ok: true, role, username });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==== /me ====
app.get("/me", async (req, res) => {
  const s = db.data.settings;
  if (!req.user)
    return res.json({
      loggedIn: false,
      adminSession: !!req.adminSession,
      settings: { monthlyTokens: s.monthlyTokens, maintenance: s.maintenance, recruiting: s.recruiting, reason: s.reason },
    });
  await ensureMonthlyRefill(req.user);
  res.json({
    loggedIn: true,
    adminSession: !!req.adminSession,
    impersonating: !!req.impersonating,
    user: { id: req.user.id, username: req.user.username, role: req.user.role, tokens: req.user.tokens },
    settings: { monthlyTokens: s.monthlyTokens, maintenance: s.maintenance, recruiting: s.recruiting, reason: s.reason },
  });
});

// ==== 送信 ====
app.post("/submit", async (req, res) => {
  const user = req.user;
  if (!user) return res.send(`<script>alert("⚠未登録です。初回登録をしてください。"); location.href="/";</script>`);
  await ensureMonthlyRefill(user);

  if (db.data.settings.maintenance) return res.send(`<script>alert("⚠現在メンテナンス中です。投稿できません。"); location.href="/";</script>`);
  if (!db.data.settings.recruiting) return res.send(`<script>alert("⚠現在は募集を終了しています。"); location.href="/";</script>`);

  const limit = Number(db.data.settings.rateLimitPerMin ?? 5);
  if (!isAdmin(user) && !hitRate(user.id, limit)) {
    return res.send(`<script>alert("⚠送信が多すぎます。しばらくしてからお試しください。（1分あたり最大 ${limit} 件）"); location.href="/";</script>`);
  }

  if (!isAdmin(user) && (!(typeof user.tokens === "number") || user.tokens <= 0)) {
    return res.send(`<script>alert("⚠${name} さん、送信には今月のトークンが不足しています。"); location.href="/";</script>`);
  }

  const appleMusicUrl = req.body.appleMusicUrl?.trim();
  const artworkUrl = req.body.artworkUrl?.trim();
  const previewUrl = req.body.previewUrl?.trim();
  const responseText = req.body.response?.trim();
  const artistText = req.body.artist?.trim() || "アーティスト不明";
  if (!appleMusicUrl || !artworkUrl || !previewUrl) return res.send(`<script>alert("⚠候補一覧から曲を選択してください"); location.href="/";</script>`);
  if (!responseText) return res.send(`<script>alert("⚠入力欄が空です。"); location.href="/";</script>`);

  // 同一曲連投の抑止
  const cooldownMin = Number(db.data.settings.duplicateCooldownMinutes ?? 15);
  const now = Date.now();
  const keyLower = `${responseText.toLowerCase()}|${artistText.toLowerCase()}`;
  const recent = [...db.data.responses].reverse().find(r => r.by?.id === user.id && `${r.text.toLowerCase()}|${r.artist.toLowerCase()}` === keyLower);
  if (recent) {
    const dt = now - new Date(recent.createdAt).getTime();
    if (dt < cooldownMin * 60 * 1000) {
      const left = Math.ceil((cooldownMin * 60 * 1000 - dt) / 60000);
      return res.send(`<script>alert("⚠同一曲の連投は ${cooldownMin} 分間できません。あと約 ${left} 分お待ちください。"); location.href="/";</script>`);
    }
  }

  db.data.songCounts[keyLower] = (db.data.songCounts[keyLower] || 0) + 1;
  const existing = db.data.responses.find(r => r.text.toLowerCase() === responseText.toLowerCase() && r.artist.toLowerCase() === artistText.toLowerCase());
  if (existing) existing.count = db.data.songCounts[keyLower];
  else db.data.responses.push({
    id: nanoid(), text: responseText, artist: artistText, appleMusicUrl, artworkUrl, previewUrl,
    count: db.data.songCounts[keyLower], createdAt: new Date().toISOString(), by: { id: user.id, username: user.username }
  });

  if (!isAdmin(user)) { user.tokens = Math.max(0, (user.tokens ?? 0) - 1); await usersDb.write(); }
  await db.write();
  res.send(`<script>alert("✅送信が完了しました！"); location.href="/";</script>`);
});

// ==== リクエスト削除 & まとめて削除 ====
function safeWriteUsers() { return usersDb.write().catch(e => console.error("users.json write error:", e)); }
function safeWriteDb() { return db.write().catch(e => console.error("db.json write error:", e)); }

app.get("/delete/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const toDelete = db.data.responses.find(e => e.id === id);
  if (toDelete) {
    const key = `${toDelete.text.toLowerCase()}|${toDelete.artist.toLowerCase()}`;
    delete db.data.songCounts[key];
  }
  db.data.responses = db.data.responses.filter(e => e.id !== id);
  await safeWriteDb();
  res.set("Content-Type", "text/html");
  res.send(`<script>alert("🗑️削除しました"); location.href="/admin";</script>`);
});

app.post("/admin/bulk-delete-requests", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const idSet = new Set(ids);
  for (const r of db.data.responses) if (idSet.has(r.id)) {
    const key = `${r.text.toLowerCase()}|${r.artist.toLowerCase()}`; delete db.data.songCounts[key];
  }
  db.data.responses = db.data.responses.filter(r => !idSet.has(r.id));
  await safeWriteDb();
  res.redirect(`/admin`);
});

// ==== GitHub 同期 ====
async function getFileSha(pathname) {
  try {
    const r = await axios.get(`https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${pathname}?ref=${BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } });
    return r.data.sha;
  } catch (e) { if (e.response?.status === 404) return null; throw e; }
}
async function putFile(pathname, contentObj, message) {
  const sha = await getFileSha(pathname);
  const contentEncoded = Buffer.from(JSON.stringify(contentObj, null, 2)).toString("base64");
  const payload = { message, content: contentEncoded, branch: BRANCH, ...(sha ? { sha } : {}) };
  return axios.put(`https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${pathname}`, payload,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } });
}
async function getFile(pathname) {
  const r = await axios.get(`https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${pathname}?ref=${BRANCH}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } });
  return JSON.parse(Buffer.from(r.data.content, "base64").toString("utf8"));
}
async function syncAllToGitHub() {
  if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) return;
  await putFile("db.json", db.data, `Sync db.json at ${new Date().toISOString()}`);
  await putFile("users.json", usersDb.data, `Sync users.json at ${new Date().toISOString()}`);
}
async function fetchAllFromGitHub() {
  if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) return;
  try { db.data = await getFile("db.json"); await safeWriteDb(); } catch (e) { console.warn("fetch db.json failed:", e.message); }
  try { usersDb.data = await getFile("users.json"); await safeWriteUsers(); } catch (e) { console.warn("fetch users.json failed:", e.message); }
}

// ==== 管理ログイン（維持） ====
app.post("/admin-login", async (req, res) => {
  const pwd = typeof req.body.password === "string" ? req.body.password.trim() : "";
  if (!pwd) return res.json({ success: false, reason: "empty" });

  const fails = getLoginFails(req);
  if (fails >= MAX_TRIES) return res.json({ success: false, reason: "locked", remaining: 0 });

  const ok = pwd === db.data.settings.adminPassword;
  if (!ok) {
    const n = fails + 1; setLoginFails(res, n);
    return res.json({ success: false, reason: "bad_password", remaining: Math.max(0, MAX_TRIES - n) });
  }

  res.cookie("adminAuth", "1", COOKIE_OPTS);
  setLoginFails(res, 0);

  res.cookie("justLoggedIn","1",COOKIE_OPTS);
  if (req.user && !isAdmin(req.user)) {
    req.user.role = "admin";
    req.user.tokens = null;
    await safeWriteUsers();
  }
  return res.json({ success: true });
});

// ==== なりすまし ====
app.post("/admin/impersonate", requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  const u = getUserById(id);
  if (!u) return res.status(404).send("Not found");
  res.cookie("impersonateId", u.id, COOKIE_OPTS);
  res.redirect("/admin/users");
});
app.get("/admin/impersonate/clear", requireAdmin, async (_req, res) => {
  res.clearCookie("impersonateId");
  res.redirect("/admin/users");
});


// ==== マイページ ====
app.get("/mypage", async (req, res) => {
  const u = req.user;
  const s = db.data.settings;
  const head = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>マイページ</title>
  <style>
    body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", "Meiryo", "MS PGothic", sans-serif;padding:20px;background:#f7f7fb;color:#111827}
    .wrap{max-width:820px;margin:0 auto}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.06);padding:18px}
    .row{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
    .avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid #e5e7eb}
    .muted{color:#6b7280}
    .pill{display:inline-block;background:#111827;color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;margin-left:6px}
    .kv{display:grid;grid-template-columns:140px 1fr;gap:8px 16px;margin-top:12px}
    a.btn{display:inline-flex;gap:8px;align-items:center;background:#111827;color:#fff;text-decoration:none;padding:8px 12px;border-radius:10px;border:1px solid #374151}
    .back{margin-top:16px}
    @media (max-width:520px){.kv{grid-template-columns:1fr} .kv b{display:block;margin-top:10px}}
  </style>`;
  if (!u) {
    return res.send(head + `<div class="wrap">
      <h1>マイページ</h1>
      <div class="card">
        <p class="muted">まだ登録されていません。</p>
        <a href="/" class="btn">トップへ戻る</a>
      </div>
    </div>`);
  }
  const tokens = (u.role === "admin") ? "∞" : (u.tokens ?? 0);
  res.send(head + `<div class="wrap">
    <h1>マイページ</h1>
    <div class="card">
      <div class="row">
        <img src="/img/mypage.png" alt="icon" class="avatar">
        <div>
          <div><b>${u.username}</b> <span class="pill">${u.role}</span></div>
          <div class="muted">deviceId: ${u.id}</div>
        </div>
      </div>
      <div class="kv">
        <b>トークン残数</b> <span>${tokens}</span>
        <b>最終配布</b> <span>${u.lastRefillISO || "-"}</span>
        <b>募集状態</b> <span>${s.recruiting ? "受付中" : "停止中"}</span>
        <b>メンテナンス</b> <span>${s.maintenance ? "ON" : "OFF"}</span>
      </div>
      <div class="back"><a class="btn" href="/">↵ トップへ</a></div>
    </div>
  </div>`);
});
// ==== 管理 UI ====

// ==== 月次配布スケジュール（Tokyo固定）の保存 ====
app.post("/admin/update-refill-schedule", requireAdmin, async (req, res) => {
  const day = Math.min(31, Math.max(1, parseInt(req.body.day, 10) || 1));
  const hour = Math.min(23, Math.max(0, parseInt(req.body.hour, 10) || 0));
  const minute = Math.min(59, Math.max(0, parseInt(req.body.minute, 10) || 0));
  if (!db.data.settings) db.data.settings = {};
  db.data.settings.refillDay = day;
  db.data.settings.refillHour = hour;
  db.data.settings.refillMinute = minute;
  db.data.settings.refillTimezone = "Asia/Tokyo";
  await db.write().catch(e => console.error("db.json write error:", e));
  try { if (typeof scheduleRefillCron === "function") scheduleRefillCron(); } catch (e) { console.error(e); }
  res.redirect("/admin");
});
app.get("/admin", requireAdmin, async (req, res) => {
  const sort = (req.query.sort || "newest").toString(); // newest | popular
  const perPage = 10;
  const page = parseInt(req.query.page || "1", 10);

  let items = [...db.data.responses];
  if (sort === "popular") items.sort((a,b)=> (b.count|0)-(a.count|0) || new Date(b.createdAt)-new Date(a.createdAt));
  else items.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);

  const pagination = (cur, total, sortKey) => {
    const btn = (p, label, disabled = false) =>
      `<a class="pg-btn ${disabled ? "disabled" : ""}" href="?page=${p}&sort=${sortKey}" ${disabled ? 'tabindex="-1"' : ""}>${label}</a>`;
    let html = `<div class="pg-wrap">`;
    html += btn(1, "« 最初", cur === 1);
    html += btn(Math.max(1, cur - 1), "‹ 前へ", cur === 1);
    for (let p = 1; p <= total; p++) {
      if (p === cur) html += `<span class="pg-btn current">${p}</span>`;
      else if (Math.abs(p - cur) <= 2 || p === 1 || p === total) html += btn(p, String(p));
      else if (Math.abs(p - cur) === 3) html += `<span class="pg-ellipsis">…</span>`;
    }
    html += btn(Math.min(total, cur + 1), "次へ ›", cur === total);
    html += btn(total, "最後 »", cur === total);
    return html + `</div>`;
  };

  let html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>管理者ページ</title>
  <style>
    .pg-wrap{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
    .pg-btn{display:inline-block;padding:8px 12px;border:1px solid #ccc;border-radius:8px;text-decoration:none;color:#333;min-width:44px;text-align:center}
    .pg-btn:hover{background:#f5f5f5}
    .pg-btn.current{background:#007bff;color:#fff;border-color:#007bff}
    .pg-btn.disabled{opacity:.5;pointer-events:none}
    .pg-ellipsis{padding:8px 4px}
    .entry-container{position:relative;display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px;border:1px solid rgba(0,0,0,.1);border-radius:10px}
    .entry-container:hover{background:#fafafa}
    .entry img{width:50px;height:50px;border-radius:5px;margin-right:10px}
    .delete{position:absolute;left:calc(100% + 10px);top:50%;transform:translateY(-50%);text-decoration:none}
    .count-badge{background:#ff6b6b;color:#fff;font-weight:bold;padding:4px 8px;border-radius:5px;margin-right:10px}
    .tools{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}
    .tools button{padding:8px 12px}
    .sec{margin:14px 0}
    code.pwd{padding:2px 6px;background:#f5f5f5;border-radius:6px;border:1px solid #eee}
    .banner-imp{padding:8px 12px;background:#fff3cd;border:1px solid #ffeeba;border-radius:8px;margin:10px 0}
  </style>
  <body>
    <h1>✉ アンケート回答一覧</h1>

    ${req.impersonating ? `<div class="banner-imp">現在 <strong>${req.user?.username || 'user'}</strong> として閲覧中（なりすまし）。 <a href="/admin/impersonate/clear">解除</a></div>` : ""}

    <div class="tools">
      <div>
        並び替え:
        <a class="pg-btn ${sort==='newest'?'current':''}" href="?sort=newest">最新順</a>
        <a class="pg-btn ${sort==='popular'?'current':''}" href="?sort=popular">人気順</a>
      </div>
      <div style="margin-left:auto;">
        <a class="pg-btn" href="/admin/users">ユーザー管理へ →</a>
      </div>
    </div>

    ${pagination(currentPage, totalPages, sort)}

    <form method="POST" action="/admin/bulk-delete-requests" id="bulkReqForm">
      <div class="tools">
        <label><input type="checkbox" id="reqSelectAll"> 全選択</label>
        <button type="submit">選択したリクエストを削除</button>
        <a class="pg-btn" href="/sync-requests">GitHubに同期</a>
        <a class="pg-btn" href="/fetch-requests">GitHubから取得</a>
      </div>

      <ul style="list-style:none; padding:0;">`;

  pageItems.forEach(e => {
    html += `<li>
      <div class="entry-container">
        <input type="checkbox" name="ids" value="${e.id}" class="req-check">
        <a href="${e.appleMusicUrl || "#"}" target="_blank" class="entry" style="display:flex;align-items:center;">
          <div class="count-badge">${e.count}</div>
          <img src="${e.artworkUrl}" alt="Cover">
          <div><strong>${e.text}</strong><br><small>${e.artist}</small></div>
        </a>
        <a href="/delete/${e.id}" class="delete">🗑️</a>
      </div>
    </li>`;
  });

  html += `</ul>
      <div class="tools">
        <button type="submit">選択したリクエストを削除</button>
      </div>
    </form>

    ${pagination(currentPage, totalPages, sort)}

    <div class="sec">
      <h2>設定</h2>
      <p>現在の管理者パスワード: <code class="pwd" id="curPwd">${db.data.settings.adminPassword}</code>
        <button onclick="navigator.clipboard.writeText(document.getElementById('curPwd').textContent)">コピー</button>
      </p>
      <form action="/update-settings" method="post">
        <div><label><input type="checkbox" name="maintenance" value="on" ${db.data.settings.maintenance ? "checked" : ""}> メンテナンス中にする</label></div>
        <div style="margin-top:6px;"><label><input type="checkbox" name="recruiting" value="off" ${db.data.settings.recruiting ? "" : "checked"}> 募集を終了する</label></div>
        <div style="margin-top:10px;"><label>理由:<br><textarea name="reason" style="width:300px;height:80px;">${db.data.settings.reason || ""}</textarea></label></div>
        <div><label>フロントエンドタイトル:<br><textarea name="frontendTitle" style="width:300px;height:60px;">${db.data.settings.frontendTitle || "♬曲をリクエストする"}</textarea></label></div>
        <div><label>管理者パスワード:<br><input type="text" name="adminPassword" placeholder="新しい管理者パスワード" style="width:300px; padding:10px;"></label></div>
        <div><label><input type="checkbox" name="playerControlsEnabled" value="on" ${db.data.settings.playerControlsEnabled ? "checked" : ""}> 再生・音量ボタンを表示</label></div>
        <div style="margin-top:10px;">
          <label>1分あたりの送信上限: <input type="number" name="rateLimitPerMin" min="1" value="${db.data.settings.rateLimitPerMin}" style="width:90px;"></label>
          <label style="margin-left:10px;">同一曲連投クールダウン(分): <input type="number" name="duplicateCooldownMinutes" min="0" value="${db.data.settings.duplicateCooldownMinutes}" style="width:90px;"></label>
        </div>
        <button type="submit" style="font-size:16px; padding:8px 14px; margin-top:6px;">設定を更新</button>
      </form>
    </div>

    <div class="sec">
      <h2>月次トークン</h2>
      <form method="POST" action="/admin/update-monthly-tokens">
        <label>月次配布数: <input type="number" min="0" name="monthlyTokens" value="${db.data.settings.monthlyTokens ?? 5}" style="width:100px;"></label>
        <button type="submit" style="margin-left:8px;">保存</button>
      </form>
      <p><a href="/admin/users">ユーザー管理へ →</a></p>
    </div>

    <p><a href="/" style="font-size:20px;">↵戻る</a></p>

    <script>
      const reqAll = document.getElementById('reqSelectAll');
      if (reqAll) reqAll.addEventListener('change', () => {
        document.querySelectorAll('.req-check').forEach(chk => chk.checked = reqAll.checked);
      });
    </script>
  <div class="sec">
  <h2>配布スケジュール（Tokyo固定）</h2>
  <form method="POST" action="/admin/update-refill-schedule" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <label>日: <input type="number" name="day" min="1" max="31" value="${db.data.settings.refillDay ?? 1}" style="width:90px;"></label>
    <label>時: <input type="number" name="hour" min="0" max="23" value="${db.data.settings.refillHour ?? 0}" style="width:90px;"></label>
    <label>分: <input type="number" name="minute" min="0" max="59" value="${db.data.settings.refillMinute ?? 10}" style="width:90px;"></label>
    <span style="opacity:.7">Timezone: Asia/Tokyo</span>
    <button type="submit">保存</button>
  </form>
  <small style="color:#666">指定日のみ配布。毎日 指定時刻(Tokyo)にチェックが走ります。</small>
</div>
</body></html>`;

  res.send(html);
});

// ==== 月次配布数の保存 ====
app.post("/admin/update-monthly-tokens", requireAdmin, async (req, res) => {
  const n = Number(req.body.monthlyTokens);
  if (!Number.isFinite(n) || n < 0)
    return res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=/admin">入力が不正です`);
  db.data.settings.monthlyTokens = n;
  await safeWriteDb();
  res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=/admin">保存しました`);
});

// ==== Users（管理者のみ + なりすましボタン） ====
app.get("/admin/users", requireAdmin, async (_req, res) => {
  await usersDb.read();
  const rows = usersDb.data.users.map(u => `
    <tr>
      <td><input type="checkbox" name="ids" value="${u.id}" class="user-check"></td>
      <td>${u.username}</td>
      <td>${u.id}</td>
      <td>${u.role}</td>
      <td>${isAdmin(u) ? "∞" : (u.tokens ?? 0)}</td>
      <td>${u.lastRefillISO || "-"}</td>
      <td style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <form method="POST" action="/admin/update-user" style="display:inline-flex; gap:6px; align-items:center; margin-right:8px;">
          <input type="hidden" name="id" value="${u.id}">
          <label>tokens:<input type="number" min="0" name="tokens" value="${isAdmin(u)?0:(u.tokens??0)}" ${isAdmin(u)?'disabled':''} style="width:90px;"></label>
          <label>role:
            <select name="role">
              <option value="user" ${u.role==='user'?'selected':''}>user</option>
              <option value="admin" ${u.role==='admin'?'selected':''}>admin</option>
            </select>
          </label>
          <button type="submit">更新</button>
        </form>
        <form method="POST" action="/admin/delete-user" style="display:inline;">
          <input type="hidden" name="id" value="${u.id}">
          <button type="submit" title="このユーザーを削除" style="cursor:pointer;">🗑️</button>
        </form>
        <form method="POST" action="/admin/impersonate" style="display:inline;">
          <input type="hidden" name="id" value="${u.id}">
          <button type="submit" title="このユーザーになりすます">👤</button>
        </form>
      </td>
    </tr>`).join("");

  res.send(`<!doctype html><meta charset="utf-8"><title>Admin Users</title>
  <style>
    .tools{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}
    .tools button{padding:8px 12px}
    table{border-collapse:collapse}
    th,td{border:1px solid #ccc;padding:6px 8px}
    .note{margin:8px 0 0;color:#555}
  </style>
  <h1>Users</h1>
  <p><a href="/admin">← Adminへ戻る</a></p>

  <form method="POST" action="/admin/bulk-delete-users" id="bulkUserForm">
    <div class="tools"><label><input type="checkbox" id="userSelectAll"> 全選択</label>
      <button type="submit">選択したユーザーを削除</button></div>
    <table cellpadding="6" cellspacing="0">
      <thead><tr><th></th><th>username</th><th>deviceId</th><th>role</th><th>tokens</th><th>lastRefill</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </form>

  <div class="tools">
    <form method="POST" action="/admin/bulk-update-user-tokens" style="display:flex;gap:8px;align-items:center;">
      <label>一般ユーザーの tokens を一括で
        <input type="number" min="0" name="tokens" value="5" style="width:100px;"> に更新</label>
      <button type="submit">実行</button>
    </form>
    <a href="/admin/impersonate/clear" class="note">なりすましを解除</a>
  </div>

  <script>
    const userAll = document.getElementById('userSelectAll');
    if (userAll) userAll.addEventListener('change', () => {
      document.querySelectorAll('.user-check').forEach(chk => chk.checked = userAll.checked);
    });
  </script>`);
});

// 個別ユーザー更新
app.post("/admin/update-user", requireAdmin, async (req, res) => {
  await usersDb.read();
  const { id, tokens, role } = req.body || {};
  const u = usersDb.data.users.find(x => x.id === id);
  if (!u) return res.status(404).send("Not found");
  if (role === "admin") { u.role = "admin"; u.tokens = null; }
  else { u.role = "user"; const n = Number(tokens); u.tokens = Number.isFinite(n) && n >= 0 ? n : 0; }
  await usersDb.write();
  res.redirect(`/admin/users`);
});
app.post("/admin/bulk-delete-users", requireAdmin, async (req, res) => {
  await usersDb.read();
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const idSet = new Set(ids);
  usersDb.data.users = usersDb.data.users.filter(u => !idSet.has(u.id));
  await usersDb.write();
  res.redirect(`/admin/users`);
});
app.post("/admin/bulk-update-user-tokens", requireAdmin, async (req, res) => {
  await usersDb.read();
  const n = Number(req.body.tokens);
  if (!Number.isFinite(n) || n < 0) return res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=/admin/users">入力が不正です`);
  for (const u of usersDb.data.users) if (!isAdmin(u)) u.tokens = n;
  await usersDb.write();
  res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=/admin/users">更新しました`);
});
app.post("/admin/delete-user", requireAdmin, async (req, res) => {
  await usersDb.read();
  const { id } = req.body || {};
  if (!id) return res.status(400).send("bad request");
  usersDb.data.users = usersDb.data.users.filter(u => u.id !== id);
  await usersDb.write();
  res.redirect(`/admin/users`);
});

// ==== 設定 ====
app.post("/update-settings", requireAdmin, async (req, res) => {
  db.data.settings.maintenance = !!req.body.maintenance;
  db.data.settings.recruiting = req.body.recruiting ? false : true;
  db.data.settings.reason = req.body.reason || "";
  db.data.settings.frontendTitle = req.body.frontendTitle || "♬曲をリクエストする";
  if (req.body.adminPassword?.trim()) db.data.settings.adminPassword = req.body.adminPassword.trim();
  db.data.settings.playerControlsEnabled = !!req.body.playerControlsEnabled;

  const rl = Number(req.body.rateLimitPerMin);
  const cd = Number(req.body.duplicateCooldownMinutes);
  if (Number.isFinite(rl) && rl > 0) db.data.settings.rateLimitPerMin = rl;
  if (Number.isFinite(cd) && cd >= 0) db.data.settings.duplicateCooldownMinutes = cd;

  await safeWriteDb();
  res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=/admin">設定を保存しました`);
});
app.get("/settings", (_req, res) => res.json(db.data.settings));

// ==== プレビュー用プロキシ ====
app.get("/preview", async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send("missing url");
    const parsed = url.parse(raw);
    const host = (parsed.hostname || "").toLowerCase();
    const allowed =
      host.endsWith("itunes.apple.com") ||
      host.endsWith("audio-ssl.itunes.apple.com") ||
      host.endsWith("mzstatic.com");
    if (!allowed) return res.status(403).send("forbidden host");

    const headers = {};
    if (req.headers.range) headers["range"] = req.headers.range;

    const r = await fetch(raw, { headers });
    res.status(r.status);
    const ct = r.headers.get("content-type") || "audio/mpeg";
    res.setHeader("Content-Type", ct);
    const len = r.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    const ar = r.headers.get("accept-ranges");
    if (ar) res.setHeader("Accept-Ranges", ar);
    const cr = r.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    res.setHeader("Cache-Control", "public, max-age=86400");
    r.body.pipe(res);
  } catch (e) {
    console.error("preview proxy error:", e);
    res.status(500).send("preview error");
  }
});

// ==== GitHub 同期（任意ボタン） ====
app.get("/sync-requests", requireAdmin, async (_req, res) => {
  try { await syncAllToGitHub(); res.redirect("/admin"); }
  catch { res.redirect("/admin"); }
});
app.get("/fetch-requests", requireAdmin, async (_req, res) => {
  try { await fetchAllFromGitHub(); res.redirect("/admin"); }
  catch { res.redirect("/admin"); }
});

// ==== 起動時 ====
await (async () => { try { await fetchAllFromGitHub(); } catch {} try { await refillAllIfMonthChanged(); } catch {} })();


// ==== Refill Scheduler (Tokyo fixed) ====
let _refillCron = null;
function scheduleRefillCron() {
  try {
    if (_refillCron) { try { _refillCron.stop(); } catch {} _refillCron = null; }
    const day = Number(db.data.settings.refillDay ?? 1);
    const hour = Number(db.data.settings.refillHour ?? 0);
    const minute = Number(db.data.settings.refillMinute ?? 10);
    const expr = `${minute} ${hour} * * *`;
    _refillCron = cron.schedule(expr, async () => {
      try {
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: "Asia/Tokyo" });
        const d = Number(todayStr.split('-')[2]);
        if (d === day) await refillAllIfMonthChanged();
      } catch (e) { console.error("refill cron error:", e); }
    }, { timezone: "Asia/Tokyo" });
    console.log(`[refill-cron] scheduled daily at`, expr, `TZ=Asia/Tokyo (refill on day=${day})`);
  } catch (e) {
    console.error("scheduleRefillCron failed:", e);
  }
}

// ==== Cron ====
cron.schedule("*/8 * * * *", async () => { try { await safeWriteDb(); await safeWriteUsers(); await syncAllToGitHub(); } catch (e) { console.error(e); } });
scheduleRefillCron();

app.listen(PORT, () => console.log(`🚀http://localhost:${PORT}`));
