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
// defaults for schedule
if (typeof db.data.settings.refillDay !== "number") db.data.settings.refillDay = 1;
if (typeof db.data.settings.refillHour !== "number") db.data.settings.refillHour = 0;
if (typeof db.data.settings.refillMinute !== "number") db.data.settings.refillMinute = 0;

// ==== Middleware ====
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// 静的配信 & ルート
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
app.use(express.static("public"));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ==== Helpers ====
// ---- Schedule helpers (Asia/Tokyo monthly schedule) ----
function latestScheduleKey(now = new Date()) {
  const s = db.data.settings || {};
  const day = Number(s.refillDay ?? 1);
  const hour = Number(s.refillHour ?? 0);
  const minute = Number(s.refillMinute ?? 0);

  const y = now.getUTCFullYear();
  const m0 = now.getUTCMonth(); // 0..11

  function schedUTC(year, mZero) {
    const last = new Date(Date.UTC(year, mZero + 1, 0)).getUTCDate(); // days in month
    const d = Math.min(day, last);
    // JST(UTC+9) to UTC
    return new Date(Date.UTC(year, mZero, d, hour - 9, minute, 0));
  }

  const thisSched = schedUTC(y, m0);
  if (now.getTime() >= thisSched.getTime()) {
    return `${y}-${String(m0 + 1).padStart(2, "0")}`;
  } else {
    // previous month key
    const py = m0 === 0 ? y - 1 : y;
    const pm = m0 === 0 ? 12 : m0;
    return `${py}-${String(pm).padStart(2, "0")}`;
  }
}

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
  const key = latestScheduleKey(new Date());
  const monthly = Number(db.data.settings.monthlyTokens ?? 5);
  if (user.lastRefillISO !== key) {
    user.tokens = monthly;
    user.lastRefillISO = key;
    user.lastRefillAtISO = new Date().toISOString();
    await usersDb.write();
  }
}
}

async function refillAllIfMonthChanged() {
  const key = latestScheduleKey(new Date());
  const monthly = Number(db.data.settings.monthlyTokens ?? 5);
  let touched = false;
  for (const u of usersDb.data.users) {
    if (!isAdmin(u) && u.lastRefillISO !== key) {
      u.tokens = monthly;
      u.lastRefillISO = key;
      u.lastRefillAtISO = new Date().toISOString();
      touched = true;
    }
  }
  if (touched) await usersDb.write();
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
// Resolve trackName/artistName from Apple Music trackViewUrl (uses ?i=TRACK_ID)
async function tryResolveTrackByUrl(appleMusicUrl) {
  try {
    const m = String(appleMusicUrl || "").match(/[?&]i=(\d+)/);
    if (!m) return null;
    const id = m[1];
    const urlStr = `https://itunes.apple.com/lookup?id=${id}&country=JP`;
    const r = await fetch(urlStr, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text.trim()) return null;
    const data = JSON.parse(text);
    const item = (data.results && data.results[0]) || null;
    if (!item) return null;
    return normalizeSong(item);
  } catch { return null; }
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
  res.json({ adminRegRemaining: regRem, adminLoginRemaining: logRem });
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
      lastRefillISO: latestScheduleKey(new Date()), lastRefillAtISO: new Date().toISOString(), registeredAt: new Date().toISOString(),
    });
    await usersDb.write();

    setRegFails(res, 0);
    res.cookie("deviceId", deviceId, COOKIE_OPTS);
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
    return res.send(`<script>alert(`⚠${user.username} さん、送信には今月のトークンが不足しています。`); location.href="/";</script>`);
  }

  const appleMusicUrl = req.body.appleMusicUrl?.trim();
  const artworkUrl = req.body.artworkUrl?.trim();
  const previewUrl = req.body.previewUrl?.trim();
  let responseText = (req.body.response ?? "").toString().trim();
  let artistText = (req.body.artist ?? "").toString().trim() || "アーティスト不明";
  if (appleMusicUrl) {
    try {
      const resolved = await tryResolveTrackByUrl(appleMusicUrl);
      if (resolved) {
        responseText = resolved.trackName || responseText;
        if (!req.body.artist) artistText = resolved.artistName || artistText;
      }
    } catch {}
  }
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

// ==== 放送済みトグル ====
app.get("/broadcast/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const r = db.data.responses.find(e => e.id === id);
  if (r) { r.broadcasted = true; r.broadcastedAt = new Date().toISOString(); await safeWriteDb(); }
  res.redirect("/admin");
});
app.get("/unbroadcast/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const r = db.data.responses.find(e => e.id === id);
  if (r) { r.broadcasted = false; r.broadcastedAt = null; await safeWriteDb(); }
  res.redirect("/admin");
});
app.post("/admin/bulk-broadcast-requests", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const idSet = new Set(ids);
  for (const r of db.data.responses) if (idSet.has(r.id)) { r.broadcasted = true; r.broadcastedAt = new Date().toISOString(); }
  await safeWriteDb();
  res.redirect("/admin");
});
app.post("/admin/bulk-unbroadcast-requests", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const idSet = new Set(ids);
  for (const r of db.data.responses) if (idSet.has(r.id)) { r.broadcasted = false; r.broadcastedAt = null; }
  await safeWriteDb();
  res.redirect("/admin");
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

// ==== 管理 UI ====
app.get("/admin", requireAdmin, async (req, res) => {
  const sort = (req.query.sort || "newest").toString(); // newest | popular
  const perPage = 10;
  const page = parseInt(req.query.page || "1", 10);

  let items = [...db.data.responses];
  const only = (req.query.only||"").toString();
  if (only==="broadcasted") items = items.filter(x=>x.broadcasted);
  if (only==="unbroadcasted") items = items.filter(x=>!x.broadcasted);
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
    .delete{text-decoration:none}
    .actions{margin-left:auto;display:flex;gap:8px;align-items:center}
    .actions a{border:1px solid #ccc;border-radius:8px;padding:6px 8px;background:#fff;color:#333}
    .actions a:hover{background:#f5f5f5}
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
        <span style="margin-left:12px">絞り込み:
          <a class="pg-btn ${ (req.query.only||'')==='broadcasted'?'current':''}" href="?sort=${sort}&only=broadcasted">放送済みのみ</a>
          <a class="pg-btn ${ (req.query.only||'')==='unbroadcasted'?'current':''}" href="?sort=${sort}&only=unbroadcasted">未放送のみ</a>
          <a class="pg-btn ${ (req.query.only||'')===''?'current':''}" href="?sort=${sort}">すべて</a>
        </span>
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
        <button type="submit" formaction="/admin/bulk-broadcast-requests">選択を放送済みに</button>
        <button type="submit" formaction="/admin/bulk-unbroadcast-requests">選択を未放送へ</button>
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
        ${e.broadcasted ? `<div class="actions"><a href="/unbroadcast/${e.id}">↩️ 未放送へ</a><a href="/delete/${e.id}" class="delete">🗑️</a></div>` : `<div class="actions"><a href="/broadcast/${e.id}">📻 放送済みへ</a><a href="/delete/${e.id}" class="delete">🗑️</a></div>`}
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
    
    <div class="sec">
      <h2>配布スケジュール</h2>
      <form method="POST" action="/admin/update-refill-schedule" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <label>毎月の日: <input type="number" min="1" max="31" name="refillDay" value="${db.data.settings.refillDay ?? 1}" style="width:90px;"></label>
        <label>時: <input type="number" min="0" max="23" name="refillHour" value="${db.data.settings.refillHour ?? 0}" style="width:90px;"></label>
        <label>分: <input type="number" min="0" max="59" name="refillMinute" value="${db.data.settings.refillMinute ?? 0}" style="width:90px;"></label>
        <span class="muted">タイムゾーン: Asia/Tokyo</span>
        <button type="submit">保存</button>
      </form>
    </div>
</div>

    <p><a href="/" style="font-size:20px;">↵戻る</a></p>

    <script>
      const reqAll = document.getElementById('reqSelectAll');
      if (reqAll) reqAll.addEventListener('change', () => {
        document.querySelectorAll('.req-check').forEach(chk => chk.checked = reqAll.checked);
      });
    </script>
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


// Save refill schedule (admin)
app.post("/admin/update-refill-schedule", requireAdmin, async (req, res) => {
  const day = Math.max(1, Math.min(31, parseInt(req.body.refillDay, 10) || 1));
  const hour = Math.max(0, Math.min(23, parseInt(req.body.refillHour, 10) || 0));
  const minute = Math.max(0, Math.min(59, parseInt(req.body.refillMinute, 10) || 0));
  db.data.settings.refillDay = day;
  db.data.settings.refillHour = hour;
  db.data.settings.refillMinute = minute;
  await safeWriteDb();
  res.redirect("/admin");
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

// ==== Cron ====
cron.schedule("*/8 * * * *", async () => { try { await safeWriteDb(); await safeWriteUsers(); await syncAllToGitHub(); } catch (e) { console.error(e); } });
cron.schedule("*/2 * * * *", async () => { try { await refillAllIfMonthChanged(); } catch (e) { console.error(e); } });

// My Page (server-rendered)
app.get("/mypage", async (req, res) => {
  if (!req.user) return res.send(`<!doctype html><meta charset="utf-8"><p>未ログインです。<a href="/">トップへ</a></p>`);
  const u = req.user;
  const sset = db.data.settings || {};
  const tz = "Asia/Tokyo";
  const day = Number(sset.refillDay ?? 1);
  const hour = Number(sset.refillHour ?? 0);
  const minute = Number(sset.refillMinute ?? 0);

  function nextRefillDate() {
    const now = new Date();
    const jst = new Date(now.getTime() + 9*60*60*1000);
    let y = jst.getUTCFullYear();
    let m = jst.getUTCMonth() + 1;
    const last = new Date(y, m, 0).getDate();
    const d = Math.min(day, last);
    function build(y,m){ return new Date(Date.UTC(y, m-1, d, hour-9, minute, 0)); }
    let target = build(y, m);
    if (now.getTime() >= target.getTime()) {
      if (m === 12) { y += 1; m = 1; } else { m += 1; }
      const last2 = new Date(y, m, 0).getDate();
      const d2 = Math.min(day, last2);
      target = new Date(Date.UTC(y, m-1, d2, hour-9, minute, 0));
    }
    return target;
  }
  const nextRef = nextRefillDate();

  const fmt = (iso) => { try { return iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: tz }) : "-"; } catch { return iso || "-"; } };
  const head = `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>マイページ</title>
<style>
  :root{ --bg:#f3f4f6; --card:#ffffff; --text:#111827; --muted:#6b7280; --border:#e5e7eb; --ok:#10b981;}
  body{margin:0;background:linear-gradient(180deg,#eef2f7 0%,#f6f7fb 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial}
  .wrap{max-width:980px;margin:24px auto;padding:0 16px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin:14px 0;box-shadow:0 6px 18px rgba(16,24,40,.06)}
  .row{display:flex;gap:12px;align-items:center}
  .muted{color:var(--muted)}
  .kv{display:grid;grid-template-columns:160px 1fr;gap:8px 12px;margin-top:12px;align-items:center}
  .list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
  .item{display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 2px 10px rgba(16,24,40,.05)}
  .item img{width:60px;height:60px;border-radius:10px}
  .badge{background:var(--ok);color:#fff;border-radius:999px;padding:2px 8px;font-size:12px;margin-left:8px}
  .badge.gray{background:#9ca3af;color:#fff}
  .btn{display:inline-block;padding:8px 12px;border:1px solid var(--border);border-radius:10px;text-decoration:none;color:#111827;background:#f9fafb}
  .btn:hover{background:#eef2f7}
  .btn.gray{background:#eee;border-color:#d1d5db;color:#111}
  .btn.gray:hover{background:#e5e7eb}
  .icon-mypage{width:24px;height:24px;margin-left:8px;vertical-align:middle}
  .f-right{margin-left:auto}
</style><body>`;

  const my = db.data.responses.filter(r => r.by?.id === u.id).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  const items = (my.length===0)
    ? `<p class="muted">🤫シーッ、まだここには何もないようです。</p>`
    : `<ul class="list">${my.map(r => `
      <li class="item">
        <img src="${r.artworkUrl}" alt="cover">
        <div>
          <div><b>${r.text}</b> <small class="muted">/ ${r.artist}</small> ${r.broadcasted ? '<span class="badge">放送済み</span>' : '<span class="badge gray">未放送</span>'}</div>
          <div class="muted">${new Date(r.createdAt).toLocaleString("ja-JP")}</div>
        </div>
        <a class="btn gray f-right" href="${r.appleMusicUrl || '#'}" target="_blank" rel="noopener">Apple Music ↗</a>
      </li>`).join("")}</ul>`;
let html = head + `<div class="wrap">
    <div class="card">
      <div class="row">
        <div style="font-size:18px;font-weight:600;">${u.username} さんのマイページ <img src="/mypage.png" alt="mypage" class="icon-mypage"></div>
        
      </div>
      <div class="kv">
        <b>初回登録</b> <span>${fmt(u.registeredAt)}</span>
        <b>残トークン</b> <span>${isAdmin(u) ? '∞' : (u.tokens ?? 0)}</span>
        <b>最終配布</b> <span>${fmt(u.lastRefillAtISO) || (u.lastRefillISO || "-")}</span>
        <b>次回配布予定</b> <span>${nextRef.toLocaleString("ja-JP", { timeZone: tz })} (Asia/Tokyo)</span>
      </div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:4px;">
      次回配布予定: <span id="refillDate">${new Date(nextRef).toLocaleString("ja-JP", { timeZone: tz })}</span>
      （<span id="refillCountdown"></span>）
    </div>
    <span id="refillTarget" data-next-ref="${nextRef.toISOString()}" style="display:none"></span>

      <h3>自分の投稿一覧</h3>
      ${items}
    </div>
    <p><a href="/">↩ トップへ戻る</a></p>
  </div>`;
  html += `<script>
    (function(){
      var targetEl = document.getElementById('refillTarget');
      if(!targetEl) return;
      var ts = targetEl.getAttribute('data-next-ref');
      var target = ts ? new Date(ts) : null;
      var out = document.getElementById('refillCountdown');
      function tick(){
        if(!target || !out) return;
        var now = new Date();
        var diff = Math.max(0, Math.floor((target - now)/1000));
        var d = Math.floor(diff/86400); diff -= d*86400;
        var h = Math.floor(diff/3600); diff -= h*3600;
        var m = Math.floor(diff/60);
        var s = diff - m*60;
        var parts = [];
        if (d) parts.push(d + "日");
        parts.push(String(h).padStart(2,"0") + "時間", String(m).padStart(2,"0") + "分", String(s).padStart(2,"0") + "秒");
        out.textContent = parts.join(" ");
        requestAnimationFrame(tick);
      }
      tick();
    })();
  </script>`;
  res.send(html + "</body></html>");
});

app.listen(PORT, () => console.log(`🚀http://localhost:${PORT}`));