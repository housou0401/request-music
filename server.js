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

const toastPage = (msg, redirect="/") => `<!doctype html><html lang="ja"><meta charset="utf-8">
<style>
.toast-wrap{position:fixed;right:18px;bottom:18px;z-index:9999;max-width:380px;}
@media(max-width:720px){.toast-wrap{left:50%;transform:translateX(-50%);top:16px;bottom:auto;right:auto;max-width:92vw;}}
.toast{background:rgba(0,0,0,.9);color:#fff;padding:16px 18px;border-radius:14px;box-shadow:0 14px 28px rgba(0,0,0,.25);font-size:15px;line-height:1.5;display:flex;gap:10px;align-items:flex-start;}
.toast strong{display:block;font-weight:600;margin-bottom:4px;}
</style>
<body>
<div class="toast-wrap"><div class="toast">${msg}</div></div>
<script>setTimeout(function(){location.href="${redirect}";},1600);</script>
</body></html>`;

const PORT = process.env.PORT || 3000;

// ---- GitHub 同期設定 ----
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ---- LowDB ----
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
if (typeof db.data.settings.voteResetHour !== "number") db.data.settings.voteResetHour = 4;
if (typeof db.data.settings.voteResetMinute !== "number") db.data.settings.voteResetMinute = 0;



// ---- Theme / Vote defaults ----
if (!db.data.theme) db.data.theme = {
  active: false,
  id: null,
  title: "",
  description: "",
  startAtISO: null,
  endAtISO: null,
  status: "inactive",
  winnerRequestId: null,
  winner: null,
  endedAtISO: null,
  mergedAtISO: null,
  endReason: null,
};
if (!Array.isArray(db.data.themeRequests)) db.data.themeRequests = [];
if (!db.data.themeSongCounts) db.data.themeSongCounts = {};
if (!Array.isArray(db.data.themeHistory)) db.data.themeHistory = [];


// ---- cookieからトークンを取得 ----
const TOK_COOKIE = "tok";
function readTokCookie(req){
  try{
    const s = req.cookies?.[TOK_COOKIE];
    if (!s) return null;
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  }catch{return null;}
}
function writeTokCookie(res, user){
  try{
    if (!user) return;
    const payload = { tokens: user.tokens ?? null, lastRefillISO: user.lastRefillISO ?? null, lastRefillAtISO: user.lastRefillAtISO ?? null };
    res.cookie(TOK_COOKIE, Buffer.from(JSON.stringify(payload)).toString("base64"), COOKIE_OPTS);
  }catch{}
}
// ==== ミドルウェア ====
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// 静的配信 & ルート
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
app.use(express.static("public"));
// public/index.html をトップとして配信
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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

const TZ = "Asia/Tokyo";
// JST日付キー（YYYY-MM-DD）
const jstDateKey = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const getVoteResetMs = () => {
  const s = db.data.settings || {};
  const h = Number.isFinite(Number(s.voteResetHour)) ? Number(s.voteResetHour) : 4;
  const min = Number.isFinite(Number(s.voteResetMinute)) ? Number(s.voteResetMinute) : 0;
  return (h * 60 + min) * 60 * 1000;
};
// 投票の「1日」はJSTの指定時刻で切り替える（例: 04:00）
const voteDateKey = (date = new Date()) => jstDateKey(new Date(date.getTime() - getVoteResetMs()));
const fmtJst = (iso) => {
  try { return new Date(iso).toLocaleString("ja-JP", { timeZone: TZ }); } catch { return "-"; }
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));

// theme helpers
function themeActiveNow() {
  const t = db.data.theme;
  if (!t || !t.active) return false;
  if (!t.endAtISO) return true;
  const end = new Date(t.endAtISO).getTime();
  if (!Number.isFinite(end)) return true;
  return Date.now() < end;
}
function parseJstDatetimeLocalToIso(localStr) {
  const s = String(localStr || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const Y = Number(m[1]), Mo = Number(m[2]) - 1, D = Number(m[3]);
  const H = Number(m[4]), Mi = Number(m[5]);
  // datetime-local is interpreted as Asia/Tokyo (UTC+9)
  const utcMs = Date.UTC(Y, Mo, D, H - 9, Mi, 0, 0);
  return new Date(utcMs).toISOString();
}
async function ensureThemeAutoClose() {
  const t = db.data.theme;
  if (!t || !t.active || !t.endAtISO) return;
  const end = new Date(t.endAtISO).getTime();
  if (Number.isFinite(end) && Date.now() >= end) {
    await endThemeAndMerge("auto");
  }
}
async function endThemeAndMerge(reason = "manual") {
  const t = db.data.theme;
  if (!t || !t.active) return;

  t.active = false;
  t.status = "ended";
  t.endedAtISO = new Date().toISOString();
  t.endReason = reason;

  const candidates = Array.isArray(db.data.themeRequests) ? db.data.themeRequests : [];

  // winner: votes desc, count desc, latest request
  let winner = null;
  for (const r of candidates) {
    if (!winner) winner = r;
    else if ((r.votes || 0) > (winner.votes || 0)) winner = r;
    else if ((r.votes || 0) === (winner.votes || 0) && (r.count || 0) > (winner.count || 0)) winner = r;
    else if ((r.votes || 0) === (winner.votes || 0) && (r.count || 0) === (winner.count || 0)) {
      const ta = new Date(r.lastRequestedAt || r.createdAt || 0).getTime();
      const tb = new Date(winner.lastRequestedAt || winner.createdAt || 0).getTime();
      if (ta > tb) winner = r;
    }
  }
  t.winnerRequestId = winner?.id || null;
  t.winner = winner ? {
    id: winner.id,
    text: winner.text,
    artist: winner.artist,
    appleMusicUrl: winner.appleMusicUrl,
    artworkUrl: winner.artworkUrl,
    previewUrl: winner.previewUrl,
    votes: winner.votes || 0,
    count: winner.count || 0,
  } : null;

  // archive snapshot
  db.data.themeHistory = db.data.themeHistory || [];
  db.data.themeHistory.unshift({
    id: t.id,
    title: t.title,
    description: t.description,
    startAtISO: t.startAtISO,
    endAtISO: t.endAtISO,
    endedAtISO: t.endedAtISO,
    endReason: t.endReason,
    winner: t.winner,
    requests: candidates,
  });

  // merge into normal list
  db.data.songCounts = db.data.songCounts || {};
  db.data.responses = db.data.responses || [];
  for (const r of candidates) {
    const keyLower = `${String(r.text || "").toLowerCase()}|${String(r.artist || "").toLowerCase()}`;
    const add = Math.max(1, Number(r.count || 1));
    db.data.songCounts[keyLower] = (db.data.songCounts[keyLower] || 0) + add;

    const existing = db.data.responses.find(x =>
      String(x.text || "").toLowerCase() === String(r.text || "").toLowerCase() &&
      String(x.artist || "").toLowerCase() === String(r.artist || "").toLowerCase()
    );
    if (existing) {
      existing.count = db.data.songCounts[keyLower];
      const exT = new Date(existing.lastRequestedAt || existing.createdAt || 0).getTime();
      const rT = new Date(r.lastRequestedAt || r.createdAt || 0).getTime();
      if (rT > exT) {
        existing.lastRequestedAt = r.lastRequestedAt || r.createdAt;
        existing.lastBy = r.lastBy || r.by || null;
      }
      existing.appleMusicUrl = r.appleMusicUrl || existing.appleMusicUrl;
      existing.artworkUrl = r.artworkUrl || existing.artworkUrl;
      existing.previewUrl = r.previewUrl || existing.previewUrl;
    } else {
      db.data.responses.push({
        id: nanoid(),
        text: r.text,
        artist: r.artist,
        appleMusicUrl: r.appleMusicUrl,
        artworkUrl: r.artworkUrl,
        previewUrl: r.previewUrl,
        count: db.data.songCounts[keyLower],
        createdAt: r.createdAt || new Date().toISOString(),
        by: r.by || r.lastBy || null,
        lastRequestedAt: r.lastRequestedAt || r.createdAt || new Date().toISOString(),
        lastBy: r.lastBy || r.by || null,
        fromThemeId: t.id,
      });
    }
  }

  // clear current theme pool
  db.data.themeRequests = [];
  db.data.themeSongCounts = {};
  t.mergedAtISO = new Date().toISOString();

  await safeWriteDb();
}

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

// ---- 月次トークン配布 ----
async function ensureMonthlyRefill(user) {
  if (!user || isAdmin(user)) return;
  const m = monthKey();
  const monthly = Number(db.data.settings.monthlyTokens ?? 5);
  const monthChanged = user.lastRefillISO !== m;

  // ---- 月が変わっておらず、トークンも数値として存在しているなら触らない ----
  if (!monthChanged && typeof user.tokens === "number") {
    return;
  }

  user.tokens = monthly;
  user.lastRefillISO = m;

  // ---- 月が変わったとき、またはまだ入っていないときだけ時刻を更新----
  if (monthChanged || !user.lastRefillAtISO) {
    user.lastRefillAtISO = new Date().toISOString();
  }

  user.refillToastPending = true;
  await usersDb.write();
}
async function refillAllIfMonthChanged() {
  const m = monthKey();
  const monthly = Number(db.data.settings.monthlyTokens ?? 5);
  let touched = false;
  for (const u of usersDb.data.users) {
    if (!isAdmin(u) && u.lastRefillISO !== m) {
      u.tokens = monthly;
      u.lastRefillISO = m;
      u.lastRefillAtISO = new Date().toISOString();
      touched = true;
    }
  }
  if (touched) await usersDb.write();
}

// ---- Cookie → ユーザ / アドミンセッション / なりすまし ----
app.use(async (req, _res, next) => {
  const baseDeviceId = req.cookies?.deviceId || null;
  const baseUser = baseDeviceId ? getUserById(baseDeviceId) : null;

  // ---- admin セッションは「adminユーザー」または「adminAuthクッキー」で判定 ----
  const adminSession = (baseUser && isAdmin(baseUser)) || (req.cookies?.adminAuth === "1");

  // ---- なりすまし ----
  let effectiveUser = baseUser;
  let impersonating = false;
  const impId = req.cookies?.impersonateId;
  if (impId && adminSession) {
    const target = getUserById(impId);
    if (target) { effectiveUser = target; impersonating = true; }
  }

  if (effectiveUser) await ensureMonthlyRefill(effectiveUser);
  await ensureThemeAutoClose();


  
  // Recover from mirror cookie if tokens missing (ephemeral disk cold starts)
  const tokMirror = readTokCookie(req);
  if (effectiveUser && (typeof effectiveUser.tokens !== "number") && tokMirror && typeof tokMirror.tokens === "number") {
    effectiveUser.tokens = tokMirror.tokens;
    if (tokMirror.lastRefillISO) effectiveUser.lastRefillISO = tokMirror.lastRefillISO;
    if (tokMirror.lastRefillAtISO) effectiveUser.lastRefillAtISO = tokMirror.lastRefillAtISO;
    await usersDb.write();
}

// ---- トークン補充の初回ログイン時トースト ----
  if (effectiveUser && effectiveUser.refillToastPending) {
    // ---- GET のときだけトーストページへリダイレクト ----
    if (req.method === "GET" && req.path !== "/refill-toast") {
      return _res.send(toastPage("🪄トークンが補充されました！", "/"));
    }
    // ---- それ以外は次のレスポンスで出すように残しておく ----
  }

  req.user = effectiveUser || null;
  req.adminSession = !!adminSession;
  req.impersonating = impersonating;
  try { if (effectiveUser) writeTokCookie(_res, effectiveUser); } catch {}
  next();
});

// ---- 管理者保護 ----
function requireAdmin(req, res, next) {
  if (req.adminSession) return next();
  return res
    .status(403)
    .send(`<!doctype html><meta charset="utf-8"><title>403</title><p>管理者のみアクセスできます。</p><p><a href="/">トップへ</a></p>`);
}

// ==========================
// Apple Music 検索
// ==========================

// ---- 共通：iTunes Search API 呼び出し ----
async function itunesSearch(params) {
  const qs = new URLSearchParams({ country: "JP", media: "music", limit: "30", ...params });
  const urlStr = `https://itunes.apple.com/search?${qs.toString()}`;
  const resp = await fetch(urlStr, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) return { results: [] };
  const text = await resp.text();
  if (!text.trim()) return { results: [] };
  try { return JSON.parse(text); } catch { return { results: [] }; }
}

// ---- アーティストの楽曲一覧 ----
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

// ---- 結果の標準化 ----
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

// ---- 並び替えキー取得（クッキー or クエリ） ----
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

// ---- 検索 API ----
app.get("/search", async (req, res) => {
  try {
    const mode = (req.query.mode || "song").toString();
    const sortKey = getSearchSort(req);

    if (mode === "artist") {
      if (req.query.artistId) {
        const tracks = await itunesLookupSongsByArtist(req.query.artistId.toString().trim());
        return res.json(sortSongs(tracks, sortKey).slice(0, 30));
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
      return res.json(sortArtists([...artistMap.values()], sortKey).slice(0, 30));
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
    return res.json(sortSongs(songs, sortKey).slice(0, 30));
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

// ---- 認証状態 ----
app.get("/auth/status", (req, res) => {
  const regRem = Math.max(0, MAX_TRIES - getRegFails(req));
  const logRem = Math.max(0, MAX_TRIES - getLoginFails(req));
  res.json({ adminRegRemaining: regRem, adminLoginRemaining: logRem });
});

// ---- 登録 ----
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
    const nowIso = new Date().toISOString();
    usersDb.data.users.push({
      id: deviceId,
      username,
      deviceInfo: deviceInfoFromReq(req),
      role,
      tokens: role === "admin" ? null : monthly,
      lastRefillISO: monthKey(),
      lastRefillAtISO: nowIso,
      registeredAt: nowIso,
    });
    await usersDb.write();
setRegFails(res, 0);
    res.cookie("deviceId", deviceId, COOKIE_OPTS);
    if (role === "admin") res.cookie("adminAuth", "1", COOKIE_OPTS);
    writeTokCookie(res, usersDb.data.users.at(-1)); 
    res.json({ ok: true, role, username });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- /me ----
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

// ---- 送信 ----
app.post("/submit", async (req, res) => {
  const user = req.user;
  if (!user) return res.send(toastPage("⚠未登録です。初回登録をしてください。", "/"));
  await ensureMonthlyRefill(user);

  if (db.data.settings.maintenance) return res.send(toastPage("⚠現在メンテナンス中です。投稿できません。", "/"));
  if (!db.data.settings.recruiting) return res.send(toastPage("⚠現在は募集を終了しています。", "/"));

  const limit = Number(db.data.settings.rateLimitPerMin ?? 5);
  if (!isAdmin(user) && !hitRate(user.id, limit)) {
    return res.send(toastPage(`⚠送信が多すぎます。しばらくしてからお試しください。（1分あたり最大 ${limit} 件）`, "/"));
  }

  if (!isAdmin(user) && (!(typeof user.tokens === "number") || user.tokens <= 0)) {
    return res.send(toastPage(`⚠${user.username} さん、送信には今月のトークンが不足しています。`, "/"));
  }

  const appleMusicUrl = (req.body.appleMusicUrl || "").trim();
  const artworkUrl = (req.body.artworkUrl || "").trim();
  const previewUrl = (req.body.previewUrl || "").trim();
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

  if (!appleMusicUrl || !artworkUrl || !previewUrl) {
    return res.send(toastPage("⚠候補一覧から曲を選択してください", "/"));
  }
  if (!responseText) {
    return res.send(toastPage("⚠入力欄が空です。", "/"));
  }

  const cooldownMin = Number(db.data.settings.duplicateCooldownMinutes ?? 15);
  const now = Date.now();
  const keyLower = `${responseText.toLowerCase()}|${artistText.toLowerCase()}`;
  const cooldownList = themeActiveNow() ? (db.data.themeRequests || []) : (db.data.responses || []);
  const recent = [...cooldownList].reverse().find(r => r.by?.id === user.id && `${r.text.toLowerCase()}|${r.artist.toLowerCase()}` === keyLower);
  if (recent) {
    const dt = now - new Date(recent.createdAt).getTime();
    if (dt < cooldownMin * 60 * 1000) {
      const left = Math.ceil((cooldownMin * 60 * 1000 - dt) / 60000);
      return res.send(toastPage(`⚠同一曲の連投は ${cooldownMin} 分間できません。あと約 ${left} 分お待ちください。`, "/"));
    }
  }

await ensureThemeAutoClose();
const themeOn = themeActiveNow();
const nowIso = new Date().toISOString();

const counts = themeOn ? (db.data.themeSongCounts ||= {}) : (db.data.songCounts ||= {});
const list = themeOn ? (db.data.themeRequests ||= []) : (db.data.responses ||= []);

counts[keyLower] = (counts[keyLower] || 0) + 1;

const existing = list.find(r =>
  String(r.text || "").toLowerCase() === responseText.toLowerCase() &&
  String(r.artist || "").toLowerCase() === artistText.toLowerCase()
);

if (existing) {
  existing.count = counts[keyLower];
  existing.lastRequestedAt = nowIso;
  existing.lastBy = { id: user.id, username: user.username };
  existing.appleMusicUrl = appleMusicUrl;
  existing.artworkUrl = artworkUrl;
  existing.previewUrl = previewUrl;
} else {
  list.push({
    id: nanoid(),
    text: responseText,
    artist: artistText,
    appleMusicUrl,
    artworkUrl,
    previewUrl,
    count: counts[keyLower],
    createdAt: nowIso,
    by: { id: user.id, username: user.username },
    lastRequestedAt: nowIso,
    lastBy: { id: user.id, username: user.username },
    ...(themeOn ? { votes: 0 } : {})
  });
}

if (!isAdmin(user)) {
    user.tokens = Math.max(0, (user.tokens ?? 0) - 1);
    await usersDb.write();
}
  await db.write();
  return res.send(toastPage(themeActiveNow() ? "✅テーマ曲として応募しました！投票は「テーマ投票」からできます。" : "✅送信が完了しました！", "/"));
});



// ---- リクエスト削除 & まとめて削除 ----
function safeWriteUsers() { return usersDb.write().catch(e => console.error("users.json write error:", e)); }
function safeWriteDb() { return db.write().catch(e => console.error("db.json write error:", e)); }

app.get("/delete/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const scope = (req.query.scope || "main").toString(); // main | theme

  const list = scope === "theme" ? (db.data.themeRequests || []) : (db.data.responses || []);
  const counts = scope === "theme" ? (db.data.themeSongCounts || {}) : (db.data.songCounts || {});

  const toDelete = list.find(e => e.id === id);
  if (toDelete) {
    const key = `${String(toDelete.text || "").toLowerCase()}|${String(toDelete.artist || "").toLowerCase()}`;
    const cur = Number(counts[key] || 0);
    const dec = Math.max(1, Number(toDelete.count || 1));
    const next = cur - dec;
    if (next > 0) counts[key] = next;
    else delete counts[key];
  }

  const filtered = list.filter(e => e.id !== id);
  if (scope === "theme") db.data.themeRequests = filtered;
  else db.data.responses = filtered;

  await safeWriteDb();
  res.set("Content-Type", "text/html");
  res.send(toastPage("🗑️削除しました", "/admin"));
});



app.post("/admin/bulk-delete-requests", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const idSet = new Set(ids);

  for (const r of db.data.responses || []) {
    if (idSet.has(r.id)) {
      const key = `${String(r.text || "").toLowerCase()}|${String(r.artist || "").toLowerCase()}`;
      const cur = Number(db.data.songCounts[key] || 0);
      const dec = Math.max(1, Number(r.count || 1));
      const next = cur - dec;
      if (next > 0) db.data.songCounts[key] = next;
      else delete db.data.songCounts[key];
    }
  }

  db.data.responses = (db.data.responses || []).filter(r => !idSet.has(r.id));
  await safeWriteDb();
  res.redirect(`/admin`);
});

// ---- GitHub 同期 ----
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

async function syncAllToGitHub(triggerDeploy = false) {
  if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) return;
  // まず最新のGitHub版を取得して差分チェック
  let remoteDb = null, remoteUsers = null;
  try { remoteDb = await getFile("db.json"); } catch {}
  try { remoteUsers = await getFile("users.json"); } catch {}
  const localDbStr = JSON.stringify(db.data, null, 2);
  const remoteDbStr = remoteDb ? JSON.stringify(remoteDb, null, 2) : null;
  const localUsersStr = JSON.stringify(usersDb.data, null, 2);
  const remoteUsersStr = remoteUsers ? JSON.stringify(remoteUsers, null, 2) : null;
  let changed = false;
  if (localDbStr !== remoteDbStr) {
    await putFile("db.json", db.data, `Sync db.json at ${new Date().toISOString()}`);
    changed = true;
  }
  if (localUsersStr !== remoteUsersStr) {
    await putFile("users.json", usersDb.data, `Sync users.json at ${new Date().toISOString()}`);
    changed = true;
  }
  if (changed && triggerDeploy && process.env.RENDER_DEPLOY_HOOK) {
    try {
      await fetch(process.env.RENDER_DEPLOY_HOOK, { method: "POST" });
    } catch (e) {
      console.warn("deploy hook failed:", e.message);
    }
  }
}
async function fetchAllFromGitHub(triggerDeploy = false) {
  if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) return;
  let changed = false;
  try {
    const remoteDb = await getFile("db.json");
    if (JSON.stringify(remoteDb, null, 2) !== JSON.stringify(db.data, null, 2)) {
      db.data = remoteDb;
      await safeWriteDb();
      changed = true;
    }
  } catch (e) { console.warn("fetch db.json failed:", e.message); }
  try {
    const remoteUsers = await getFile("users.json");
    if (JSON.stringify(remoteUsers, null, 2) !== JSON.stringify(usersDb.data, null, 2)) {
      usersDb.data = remoteUsers;
      await safeWriteUsers();
      changed = true;
    }
  } catch (e) { console.warn("fetch users.json failed:", e.message); }
  if (changed && triggerDeploy && process.env.RENDER_DEPLOY_HOOK) {
    try {
      await fetch(process.env.RENDER_DEPLOY_HOOK, { method: "POST" });
    } catch (e) { console.warn("deploy hook failed:", e.message); }
  }
}

// ---- 管理ログイン ----
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

// ---- なりすまし ----
app.post("/admin/impersonate", requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  const u = getUserById(id);
  if (!u) return res.status(404).send("Not found");
  res.cookie("impersonateId", u.id, COOKIE_OPTS);
  return res.send(toastPage(`✅ ${u.username} でサイトを閲覧します。`, "/admin/users"));
});
app.get("/admin/impersonate/clear", requireAdmin, async (_req, res) => {
  res.clearCookie("impersonateId");
  return res.send(toastPage("👥 なりすましを解除しました。", "/admin/users"));
});
// ---- 管理 UI ----
app.get("/admin", requireAdmin, async (req, res) => {
  const sort = (req.query.sort || "newest").toString(); // newest | popular
  const only = (req.query.only || "all").toString();
  const perPage = 10;
  const page = parseInt(req.query.page || "1", 10);

  let items = [...db.data.responses];
  if (only === "broadcasted") items = items.filter(r => r.broadcasted);
  if (only === "unbroadcasted") items = items.filter(r => !r.broadcasted);
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
    .entry-container{position:relative;display:flex;align-items:center;gap:10px;margin:0 0 10px 0;padding:8px;border:1px solid rgba(0,0,0,.1);border-radius:10px;max-width:980px;}
    .entry-container:hover{background:#fafafa}
    .entry{display:flex;align-items:center;gap:10px;flex:1;min-width:0;}
    .entry img{width:50px;height:50px;border-radius:5px;margin-right:10px;flex:0 0 auto;}
    .entry-text{min-width:0;}
    .entry-text strong{display:inline-block;max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;}
    .delete{text-decoration:none}
    .count-badge{background:#ff6b6b;color:#fff;font-weight:bold;padding:4px 8px;border-radius:5px;margin-right:10px;flex:0 0 auto;}
    .tools{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}
    .tools button{padding:8px 12px}
    .sec{margin:14px 0}
    code.pwd{padding:2px 6px;background:#f5f5f5;border-radius:6px;border:1px solid #eee}
    .banner-imp{padding:8px 12px;background:#fff3cd;border:1px solid #ffeeba;border-radius:8px;margin:10px 0}
    .badge{background:#10b981;color:#fff;border-radius:999px;padding:2px 8px;font-size:12px;margin-left:6px;display:inline-block;line-height:1.3;vertical-align:middle;}
    .badge.gray{background:#9ca3af;}
    .meta{font-size:12px;color:#555;display:flex;align-items:center;gap:6px;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .meta code{padding:2px 6px;background:#f5f5f5;border:1px solid #eee;border-radius:6px;}
  
/* --- admin layout improvements (keeps request list design) --- */
body{background:#f4f6fb;}
.admin-wrap{max-width:1100px;margin:24px auto;padding:0 14px;}
.admin-grid{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px;}
@media (min-width:980px){.admin-grid{grid-template-columns:1.2fr .8fr;}}
.admin-card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.06);padding:14px;}
.admin-card h2{margin:0 0 10px;font-size:16px;}
.admin-card .muted{opacity:.75;font-size:12px;}
.admin-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;}
.admin-row label{display:flex;gap:6px;align-items:center;font-size:13px;}
.admin-row input[type="number"], .admin-row input[type="text"], .admin-row input[type="datetime-local"]{padding:6px 8px;border-radius:10px;border:1px solid rgba(0,0,0,.15);}
.admin-row button{padding:8px 10px;border-radius:12px;border:none;background:#1e3a8a;color:#fff;cursor:pointer;}
.admin-row button.secondary{background:#334155;}
.req-time{font-size:12px;opacity:.75;margin-right:10px;}

/* --- admin header / cards --- */
.admin-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 0 12px;}
.admin-head h1{margin:0;font-size:22px;letter-spacing:.2px;}
.admin-head-actions{display:flex;gap:8px;flex-wrap:wrap;}
.admin-subtitle{margin:10px 0 8px;font-size:15px;opacity:.8;}
/* section cards */
.sec{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.06);padding:14px;margin:14px 0;max-width:1100px;}
.sec h2{margin:0 0 10px;font-size:16px;}
/* request list card wrapper */
.list-card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.06);padding:12px 12px;margin:10px 0;max-width:1100px;}
/* meta inline */
.meta{font-size:12px;color:#555;display:flex;align-items:center;gap:6px;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.meta code{padding:2px 6px;background:#f5f5f5;border:1px solid #eee;border-radius:6px;}

</style>
  <body>
    <div class="admin-wrap">
    <div class="admin-head">
      <h1>🎛 管理者ページ</h1>
      <div class="admin-head-actions">
        <a class="pg-btn" href="/">トップへ</a>
        <a class="pg-btn" href="/admin/users">ユーザー管理</a>
      </div>
    </div>
    <h2 class="admin-subtitle">リクエスト曲一覧</h2>

    ${req.impersonating ? `<div class="banner-imp">現在 <strong>${req.user?.username || 'user'}</strong> として閲覧中（なりすまし）。 <a href="/admin/impersonate/clear">解除</a></div>` : ""}

    <div class="list-card">
    <div class="tools">
      <div>
        並び替え:
        <a class="pg-btn ${sort==='newest'?'current':''}" href="?sort=newest">最新順</a>
        <a class="pg-btn ${sort==='popular'?'current':''}" href="?sort=popular">人気順</a>
      </div>
      <div>
        絞り込み:
        <a class="pg-btn ${only==='broadcasted'?'current':''}" href="?sort=${sort}&only=broadcasted">放送済みのみ</a>
        <a class="pg-btn ${only==='unbroadcasted'?'current':''}" href="?sort=${sort}&only=unbroadcasted">未放送のみ</a>
        <a class="pg-btn ${only==='all'?'current':''}" href="?sort=${sort}&only=all">すべて</a>
      </div>
      <div style="margin-left:auto;">
        <a class="pg-btn" href="/admin/users">ユーザー管理へ →</a>
      </div>
    </div>
    </div>

    ${pagination(currentPage, totalPages, sort)}

    <form method="POST" action="/admin/bulk-delete-requests" id="bulkReqForm">
      <div class="tools">
        <label><input type="checkbox" id="reqSelectAll"> 全選択</label>
        <button type="submit" formaction="/admin/bulk-broadcast-requests">選択を放送済みに</button>
        <button type="submit" formaction="/admin/bulk-unbroadcast-requests">選択を未放送へ</button>
        <button type="submit">選択したリクエストを削除</button>
        <a class="pg-btn" href="/sync-requests">GitHubに同期</a>
        <a class="pg-btn" href="/fetch-requests">GitHubから取得</a>
      </div>

      <ul style="list-style:none; padding:0;">`;

  pageItems.forEach(e => {
    html += `<li>
      <div class="entry-container">
        <input type="checkbox" name="ids" value="${e.id}" class="req-check">
        <a href="${e.appleMusicUrl || "#"}" target="_blank" class="entry">
          <div class="count-badge">${e.count}</div>
          <img src="${e.artworkUrl}" alt="Cover">
          <div class="entry-text">
            <strong>${e.text}</strong>${e.broadcasted ? '<span class="badge">放送済み</span>' : '<span class="badge gray">未放送</span>'}<br>
            <small>${e.artist}</small>
          </div>
        </a>
        <div class="entry-actions" style="display:flex;gap:8px;align-items:center;">
          <span class="meta">
            <span>${fmtJst(e.lastRequestedAt || e.createdAt)}</span>
            <span>${esc((e.lastBy && e.lastBy.username) || (e.by && e.by.username) || "-")}</span>
            <code>${esc((e.lastBy && e.lastBy.id) || (e.by && e.by.id) || "-")}</code>
          </span>
          <a href="/broadcast/${e.id}" class="delete" title="放送済みにする">📻</a>
          <a href="/unbroadcast/${e.id}" class="delete" title="未放送に戻す">↩️</a>
          <a href="/delete/${e.id}" class="delete" title="削除">🗑️</a>
        </div>
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
  <h2>🎧 テーマ曲イベント</h2>
  ${(() => {
    const t = db.data.theme || {};
    const active = themeActiveNow();
    const candidates = [...(db.data.themeRequests || [])].sort((a,b)=>
      (b.votes||0)-(a.votes||0) || (b.count||0)-(a.count||0) || new Date(b.createdAt||0)-new Date(a.createdAt||0)
    );
    const candList = candidates.slice(0, 30).map(r => `
      <li style="margin:8px 0;">
        <div class="entry-container" style="max-width:980px;">
          <a href="${r.appleMusicUrl || "#"}" target="_blank" class="entry">
            <div class="count-badge">${r.count || 1}</div>
            <img src="${r.artworkUrl}" alt="Cover">
            <div class="entry-text">
              <strong>${esc(r.text)}</strong><br>
              <small>${esc(r.artist)}　/　投票: <b>${r.votes || 0}</b></small>
            </div>
          </a>
          <div class="entry-actions" style="display:flex;gap:8px;align-items:center;">
            <span class="meta">
              <span>${fmtJst(r.lastRequestedAt || r.createdAt)}</span>
              <span>${esc((r.lastBy && r.lastBy.username) || (r.by && r.by.username) || "-")}</span>
              <code>${esc((r.lastBy && r.lastBy.id) || (r.by && r.by.id) || "-")}</code>
            </span>
            <a href="/delete/${r.id}?scope=theme" class="delete" title="候補を削除">🗑️</a>
          </div>
        </div>
      </li>
    `).join("");
    return `
      <div style="margin:8px 0 12px;">
        <div><b>状態:</b> ${active ? '<span class="badge">募集中</span>' : '<span class="badge gray">停止中</span>'}</div>
        <div style="margin-top:4px;"><b>テーマ:</b> ${esc(t.title || "（未設定）")}</div>
        <div style="margin-top:4px;"><b>終了予定:</b> ${t.endAtISO ? fmtJst(t.endAtISO) : "手動終了"}</div>
        <div style="margin-top:4px;"><b>候補数:</b> ${(db.data.themeRequests || []).length}　<a href="/theme" class="pg-btn" style="padding:6px 10px;">投票ページへ</a></div>
      </div>
      ${active ? `
        <form method="POST" action="/admin/theme/end" style="margin:10px 0;">
          <button type="submit" style="padding:8px 12px;">今すぐ終了して通常リストに合流</button>
        </form>
      ` : `
        <form method="POST" action="/admin/theme/start" style="display:grid;gap:8px;max-width:520px;margin:10px 0;">
          <label>タイトル: <input type="text" name="title" style="width:100%;padding:10px;" placeholder="例：冬の朝に聴きたい曲"></label>
          <label>説明: <textarea name="description" style="width:100%;height:70px;padding:10px;" placeholder="例：明日までに候補曲を集めます。投票は1日1回（毎日04:00にリセット）！"></textarea></label>
          <label>終了日時（JST）: <input type="datetime-local" name="endAtLocal" style="padding:10px;"></label>
          <button type="submit" style="padding:10px 12px;">イベントを開始</button>
          <small style="color:#555;">※ 期間中に送信された曲は「テーマ候補」に入り、イベント終了時に通常の曲一覧へ合流します。</small>
        </form>
      `}
      ${candList ? `<h3 style="margin:12px 0 6px;">テーマ候補（上位30）</h3><ul style="list-style:none;padding:0;">${candList}</ul>` : `<p style="color:#666;">まだ候補曲がありません。</p>`}
    `;
  })()}
</div>

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
      <div style="margin-top:14px;">
        <h3>配布スケジュール（毎月 / Asia/Tokyo）</h3>
      <form method="POST" action="/admin/update-refill-schedule" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <label>毎月の日: <input type="number" min="1" max="31" name="refillDay" value="${db.data.settings.refillDay ?? 1}" style="width:90px;"></label>
        <label>時: <input type="number" min="0" max="23" name="refillHour" value="${db.data.settings.refillHour ?? 0}" style="width:90px;"></label>
        <label>分: <input type="number" min="0" max="59" name="refillMinute" value="${db.data.settings.refillMinute ?? 0}" style="width:90px;"></label>
        <span class="muted">タイムゾーン: Asia/Tokyo</span>
        <button type="submit">保存</button>
      </form>
        <form method="POST" action="/admin/update-vote-reset" class="admin-row" style="margin-top:10px;">
          <label>投票リセット(JST):
            <input type="number" name="voteResetHour" min="0" max="23" value="${Number(db.data.settings.voteResetHour ?? 4)}" style="width:70px;"> :
            <input type="number" name="voteResetMinute" min="0" max="59" value="${Number(db.data.settings.voteResetMinute ?? 0)}" style="width:70px;">
          </label>
          <button type="submit" class="secondary">投票リセット時刻を更新</button>
          <span class="muted">※ 1日1回（毎日04:00にリセット）の投票がこの時刻で切り替わります</span>
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
    </div>
  </body></html>`;

  res.send(html);
});

// ---- 月次配布数の保存 ----
app.post("/admin/update-monthly-tokens", requireAdmin, async (req, res) => {
  const n = Number(req.body.monthlyTokens);
  if (!Number.isFinite(n) || n < 0)
    return res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=/admin">入力が不正です`);
  db.data.settings.monthlyTokens = n;
  await safeWriteDb();
  res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=/admin">保存しました`);
});


// ---- Save refill schedule ----
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

app.post("/admin/update-vote-reset", requireAdmin, bodyParser.urlencoded({ extended: true }), async (req, res) => {
  const h = Math.max(0, Math.min(23, parseInt(req.body.voteResetHour || "4", 10)));
  const min = Math.max(0, Math.min(59, parseInt(req.body.voteResetMinute || "0", 10)));
  db.data.settings.voteResetHour = h;
  db.data.settings.voteResetMinute = min;
  await safeWriteDb();
  return res.redirect("/admin");
});
// ---- Theme (admin) ----
app.post("/admin/theme/start", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").toString().trim();
  const description = (req.body.description || "").toString().trim();
  const endAtISO = parseJstDatetimeLocalToIso(req.body.endAtLocal);

  db.data.theme = db.data.theme || {};
  db.data.theme.active = true;
  db.data.theme.status = "active";
  db.data.theme.id = nanoid(10);
  db.data.theme.title = title || "テーマ曲募集";
  db.data.theme.description = description || "";
  db.data.theme.startAtISO = new Date().toISOString();
  db.data.theme.endAtISO = endAtISO;
  db.data.theme.winnerRequestId = null;
  db.data.theme.winner = null;
  db.data.theme.endedAtISO = null;
  db.data.theme.mergedAtISO = null;
  db.data.theme.endReason = null;

  db.data.themeRequests = [];
  db.data.themeSongCounts = {};

  await safeWriteDb();
  res.redirect("/admin");
});

app.post("/admin/theme/end", requireAdmin, async (_req, res) => {
  await endThemeAndMerge("manual");
  res.redirect("/admin");
});

// ---- Theme (public) ----
app.get("/theme/status", async (_req, res) => {
  await ensureThemeAutoClose();
  const t = db.data.theme || {};
  res.json({
    active: themeActiveNow(),
    id: t.id,
    title: t.title,
    description: t.description,
    startAtISO: t.startAtISO,
    endAtISO: t.endAtISO,
    candidates: (db.data.themeRequests || []).length
  });
});

app.get("/theme", async (req, res) => {
  await ensureThemeAutoClose();
  const t = db.data.theme || {};
  const active = themeActiveNow();
  const me = req.user || null;

  const today = voteDateKey();
  const lastVoteDate = me?.themeVotes?.[t.id || ""]?.lastVoteDate || null;
  const canVote = !!me && active && lastVoteDate !== today;
  const showPrivate = !!req.adminSession; // 管理者のみ「最終リクエスト/送信者」表示

  const candidates = [...(db.data.themeRequests || [])].sort((a,b)=>
    (b.votes||0)-(a.votes||0) || (b.count||0)-(a.count||0) || new Date(b.createdAt||0)-new Date(a.createdAt||0)
  );

  const winner = t.winner;
  const last = (db.data.themeHistory || [])[0] || null;

  const candHtml = candidates.map(r => {
  const privateLine = showPrivate
    ? `<div class="sub2">最終リクエスト: ${fmtJst(r.lastRequestedAt || r.createdAt)} / ${esc((r.lastBy && r.lastBy.username) || (r.by && r.by.username) || "-")} <code>${esc((r.lastBy && r.lastBy.id) || (r.by && r.by.id) || "-")}</code></div>`
    : "";
  const voteBtn = active
    ? (me
        ? `
          <form method="POST" action="/theme/vote" style="display:inline;">
            <input type="hidden" name="id" value="${r.id}">
            <button type="submit" ${canVote ? "" : "disabled"}>投票</button>
          </form>
        `
        : `<a href="/" style="margin-left:8px;">ログインして投票</a>`)
    : "";
  return `
    <div class="cand">
      <img src="${r.artworkUrl}" alt="cover">
      <div class="info">
        <div class="ttl">${esc(r.text)}</div>
        <div class="sub">${esc(r.artist)} / リクエスト: <b>${r.count || 1}</b> / 投票: <b>${r.votes || 0}</b></div>
        ${privateLine}
        <div class="ops">
          <a href="${r.appleMusicUrl || "#"}" target="_blank">Apple Music</a>
          ${voteBtn}
        </div>
      </div>
    </div>
  `;
}).join("");


  res.send(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>テーマ投票</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;background:#f3f4f6;margin:0;padding:16px;}
    .wrap{max-width:900px;margin:0 auto;}
    .card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.06);margin:12px 0;}
    .title{font-size:22px;font-weight:800;margin:0 0 6px;}
    .desc{color:#444;white-space:pre-wrap;}
    .meta{color:#666;font-size:13px;margin-top:6px;}
    .cand{display:flex;gap:12px;padding:10px;border:1px solid rgba(0,0,0,.08);border-radius:12px;margin:10px 0;background:#fff;}
    .cand img{width:70px;height:70px;border-radius:10px;object-fit:cover;background:#eee;flex:0 0 auto;}
    .ttl{font-weight:800;}
    .sub,.sub2{color:#555;font-size:13px;margin-top:2px;}
    .ops{margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
    .ops a{color:#2563eb;text-decoration:none;}
    button{padding:8px 12px;border-radius:10px;border:1px solid rgba(0,0,0,.15);background:#111827;color:#fff;cursor:pointer;}
    button[disabled]{opacity:.5;cursor:not-allowed;}
    .badge{display:inline-block;background:#10b981;color:#fff;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;vertical-align:middle;}
    .badge.gray{background:#9ca3af;}
  </style>
  <body><div class="wrap">
    <div class="card">
      <div class="title">🎧 テーマ投票 ${active ? '<span class="badge">開催中</span>' : '<span class="badge gray">停止中</span>'}</div>
      <div style="font-size:16px;font-weight:700;">${esc(t.title || "テーマ曲")}</div>
      <div class="desc">${esc(t.description || "")}</div>
      <div class="meta">
        ${active ? `終了予定: ${t.endAtISO ? fmtJst(t.endAtISO) : "手動終了"} / 候補数: ${candidates.length}` : ""}
        ${me ? `<br>あなた: ${esc(me.username)} / 今日(${today})の投票: ${lastVoteDate === today ? "済" : "未"}` : `<br>投票するにはトップページで登録してください。`}
        ${active && me && !canVote ? `<br><b>※投票は1日1回（毎日04:00にリセット）です。</b>` : ""}
      </div>
      <div style="margin-top:10px;"><a href="/" style="text-decoration:none;">← トップへ戻る</a></div>
    </div>

    ${active ? `<div class="card"><h2 style="margin:0 0 8px;">候補曲</h2>${candHtml || "<p>まだ候補がありません。</p>"}</div>` : ""}

    ${!active && (winner || last) ? `<div class="card">
      <h2 style="margin:0 0 8px;">直近の結果</h2>
      ${winner ? `<div style="font-weight:800;">今回のテーマ曲: ${esc(winner.text)} / ${esc(winner.artist)}（投票 ${winner.votes || 0}）</div>` : (last?.winner ? `<div style="font-weight:800;">${esc(last.winner.text)} / ${esc(last.winner.artist)}（投票 ${last.winner.votes || 0}）</div>` : `<div>（まだ結果がありません）</div>`)}
      ${last ? `<div class="meta">終了: ${last.endedAtISO ? fmtJst(last.endedAtISO) : "-"}</div>` : ""}
    </div>` : ""}

  </div></body></html>`);
});

app.post("/theme/vote", bodyParser.urlencoded({ extended: true }), async (req, res) => {
  await ensureThemeAutoClose();
  const t = db.data.theme || {};
  if (!themeActiveNow()) return res.send(toastPage("⚠ 現在、投票は行われていません。", "/theme"));

  const user = req.user;
  if (!user) return res.send(toastPage("⚠ 投票するには登録が必要です。", "/"));

  const id = (req.body.id || "").toString().trim();
  const target = (db.data.themeRequests || []).find(r => r.id === id);
  if (!target) return res.send(toastPage("⚠ その候補は見つかりませんでした。", "/theme"));

  const today = voteDateKey();
  user.themeVotes = user.themeVotes || {};
  const rec = user.themeVotes[t.id] || {};
  if (rec.lastVoteDate === today) {
    return res.send(toastPage("⚠ 投票は1日1回（毎日04:00にリセット）です。明日また投票できます。", "/theme"));
  }

  user.themeVotes[t.id] = { lastVoteDate: today, votedAtISO: new Date().toISOString(), requestId: id };
  target.votes = (target.votes || 0) + 1;

  await safeWriteUsers();
  await safeWriteDb();
  res.send(toastPage("✅ 投票しました！", "/theme"));
});

// ---- Users ----
app.get("/admin/users", requireAdmin, async (_req, res) => {
  await usersDb.read();
  const rows = usersDb.data.users.map(u => `
    <tr>
      <td><input type="checkbox" name="ids" value="${u.id}" class="user-check"></td>
      <td>${u.username}</td>
      <td><code>${u.id}</code></td>
      <td>${u.role === "admin" ? "管理者" : "一般"}</td>
      <td>${isAdmin(u) ? "∞" : (u.tokens ?? 0)}</td>
      <td>${u.lastRefillAtISO ? new Date(u.lastRefillAtISO).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"}) : (u.lastRefillISO || "-")}</td>
      <td class="ops">
        <form method="POST" action="/admin/update-user" class="inline-form">
          <input type="hidden" name="id" value="${u.id}">
          <label>トークン:
            <input type="number" min="0" name="tokens" value="${isAdmin(u)?0:(u.tokens??0)}" ${isAdmin(u)?'disabled':''}>
          </label>
          <label>ロール:
            <select name="role">
              <option value="user" ${u.role==='user'?'selected':''}>一般</option>
              <option value="admin" ${u.role==='admin'?'selected':''}>管理者</option>
            </select>
          </label>
          <button type="submit">保存</button>
        </form>
        <form method="POST" action="/admin/delete-user" class="inline-form">
          <input type="hidden" name="id" value="${u.id}">
          <button type="submit" title="このユーザーを削除">🗑️</button>
        </form>
        <form method="POST" action="/admin/impersonate" class="inline-form">
          <input type="hidden" name="id" value="${u.id}">
          <button type="submit" title="このユーザーとして見る">👤</button>
        </form>
      </td>
    </tr>`).join("");

  res.send(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>ユーザー管理</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;background:#f3f4f6;margin:0;padding:16px;}
    .wrap{max-width:1100px;margin:0 auto;}
    h1{margin-bottom:6px;}
    .tools{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}
    table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(15,23,42,.06);}
    th,td{border-bottom:1px solid #e5e7eb;padding:8px 10px;text-align:left;}
    th{background:#f8fafc;font-weight:600;}
    tr:last-child td{border-bottom:none;}
    .inline-form{display:inline-flex;gap:6px;align-items:center;}
    .inline-form input[type="number"]{width:70px;}
    .inline-form select{padding:3px 4px;}
    .ops{display:flex;gap:6px;flex-wrap:wrap;}
    .back{display:inline-block;margin-bottom:10px;color:#2563eb;text-decoration:none;}
  </style>
  <body>
  <div class="wrap">
    <a class="back" href="/admin">← 管理画面に戻る</a>
    <h1>ユーザー管理</h1>
    <p>登録済みのユーザーをここで編集・削除できます。なりすましを使うと、そのユーザーのマイページを確認できます。</p>
    <div id="bulkUsersWrap">
      <div class="tools">
        <label><input type="checkbox" id="userSelectAll"> 全選択</label>
        <button type="submit">選択したユーザーを削除</button>
        <a href="/admin/impersonate/clear">なりすましを解除</a>
      </div>
      <table>
        <thead>
          <tr>
            <th style="width:34px;"></th>
            <th>ユーザー名</th>
            <th>デバイスID</th>
            <th>ロール</th>
            <th>トークン</th>
            <th>最終配布</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="tools" style="margin-top:16px;">
      <form method="POST" action="/admin/bulk-update-user-tokens" style="display:flex;gap:8px;align-items:center;">
        <label>一般ユーザーのトークンを一括で
          <input type="number" min="0" name="tokens" value="5" style="width:90px;"> に更新
        </label>
        <button type="submit">実行</button>
      </form>
    </div>
  </div>
  <script>
    const userAll = document.getElementById('userSelectAll');
    if (userAll) userAll.addEventListener('change', () => {
      document.querySelectorAll('.user-check').forEach(chk => chk.checked = userAll.checked);
    });
    // bulk delete trigger wire-up
    const bulkBtn = document.querySelector('form[action="/admin/bulk-delete-users"]') ? null : (function(){
      const btn = document.createElement('button');
      btn.textContent = '選択したユーザーを削除';
      btn.type = 'button';
      btn.onclick = function(){
        const ids = Array.from(document.querySelectorAll('.user-check:checked')).map(x=>x.value);
        const f = document.getElementById('bulkUserForm');
        const hid = document.getElementById('bulkUserIds');
        hid.value = ids;
        f.submit();
      };
      const tools = document.querySelector('.tools');
      if (tools) tools.appendChild(btn);
      return btn;
    })();
  </script>
  </body></html>`);
});

// ---- 個別ユーザー更新 ----
app.post("/admin/update-user", requireAdmin, async (req, res) => {
  await usersDb.read();
  const { id, tokens, role } = req.body || {};
  const u = usersDb.data.users.find(x => x.id === id);
  if (!u) return res.status(404).send("Not found");
  if (role === "admin") {
    u.role = "admin";
    u.tokens = null;
  } else {
    u.role = "user";
    const n = Number(tokens);
    if (Number.isFinite(n) && n >= 0) {
      u.tokens = n;
    } else {
      // 管理画面で管理者→一般にしたときにトークンが0になってしまうのを防ぐ
      u.tokens = Number(db.data.settings.monthlyTokens ?? 5);
    }
  }
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

// ---- 設定 ----
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
  try { await syncAllToGitHub(true); res.redirect("/admin"); }
  catch { res.redirect("/admin"); }
});
app.get("/fetch-requests", requireAdmin, async (_req, res) => {
  try { await fetchAllFromGitHub(true); res.redirect("/admin"); }
  catch { res.redirect("/admin"); }
});

// ---- 起動時 ----
await (async () => { try { await fetchAllFromGitHub(); } catch {} try { await refillAllIfMonthChanged(); } catch {} })();


// ---- スケジュールに従って月次トークンを配布 ----
async function refillAllBySchedule() {
  const s = db.data.settings || {};
  const day = Number(s.refillDay ?? 1);
  const hour = Number(s.refillHour ?? 0);
  const minute = Number(s.refillMinute ?? 0);
  // 現在のJST
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  let y = jst.getUTCFullYear();
  let m = jst.getUTCMonth() + 1;
  const lastDay = new Date(y, m, 0).getDate();
  const d = Math.min(day, lastDay);
  const scheduledJst = Date.UTC(y, m - 1, d, hour, minute, 0); // JST基準
  const scheduledUtc = new Date(scheduledJst - 9 * 60 * 60 * 1000);
  const lastRun = s.lastRefillRunISO ? new Date(s.lastRefillRunISO) : null;

  if (now >= scheduledUtc) {
    // 今月分が未実行なら実行
    const monthKeyNow = `${y}-${String(m).padStart(2,"0")}`;
    const already = lastRun && lastRun.getUTCFullYear() === scheduledUtc.getUTCFullYear()
      && lastRun.getUTCMonth() === scheduledUtc.getUTCMonth()
      && lastRun.getUTCDate() === scheduledUtc.getUTCDate()
      && lastRun.getUTCHours() === scheduledUtc.getUTCHours()
      && lastRun.getUTCMinutes() === scheduledUtc.getUTCMinutes();
    if (!already) {
      const monthly = Number(s.monthlyTokens ?? 5);
      for (const u of usersDb.data.users) {
        if (!isAdmin(u)) {
          u.tokens = monthly;
          u.lastRefillISO = monthKeyNow;
          u.lastRefillAtISO = new Date().toISOString();
        }
      }
      db.data.settings.lastRefillRunISO = scheduledUtc.toISOString();
      await safeWriteDb();
      await safeWriteUsers();
    }
  }
}
// ==== Cron ====

cron.schedule("*/8 * * * *", async () => { try { await safeWriteDb(); await safeWriteUsers(); await syncAllToGitHub(); } catch (e) { console.error(e); } });
cron.schedule("10 0 * * *", async () => { try { await refillAllBySchedule(); } catch (e) { console.error(e); } });
cron.schedule("* * * * *", async () => { try { await refillAllBySchedule(); } catch (e) { console.error(e); } });

// My Page (server-rendered)

app.get("/mypage", async (req, res) => {
  if (!req.user) {
    return res.send(`<!doctype html><meta charset="utf-8"><p>未ログインです。<a href="/">トップへ</a></p>`);
  }
  const u = req.user;
  // legacy: 古いユーザーで registeredAt / lastRefillAtISO が無い場合にだけ埋める
  let needWrite = false;
  if (!u.registeredAt) {
    u.registeredAt = new Date().toISOString();
    needWrite = true;
  }
  if (!u.lastRefillAtISO && u.lastRefillISO) {
    const parts = String(u.lastRefillISO).split("-");
    const yy = Number(parts[0]) || new Date().getFullYear();
    const mm = Number(parts[1]) || (new Date().getMonth() + 1);
    const d = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0));
    u.lastRefillAtISO = d.toISOString();
    needWrite = true;
  }
  if (needWrite) {
    await usersDb.write();
}

  const sset = db.data.settings || {};
  const tz = "Asia/Tokyo";

  // 管理画面に保存してある「毎月いつ配布するか」を使って次回配布日時を出す
  const day = Number(sset.refillDay ?? 1);
  const hour = Number(sset.refillHour ?? 0);
  const minute = Number(sset.refillMinute ?? 0);

  function nextRefillDate() {
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // JST
    let y = jst.getUTCFullYear();
    let m = jst.getUTCMonth() + 1; // 1..12
    const lastDay = new Date(y, m, 0).getDate();
    const d = Math.min(day, lastDay);

    // JSTで y-m-d hour:minute 作ってからUTCへ戻す
    function build(y, m) {
      const j = Date.UTC(y, m - 1, d, hour, minute, 0);
      return new Date(j - 9 * 60 * 60 * 1000);
    }

    let target = build(y, m);
    if (now >= target) {
      // 今月分を過ぎている → 翌月
      if (m === 12) {
        y += 1;
        m = 1;
      } else {
        m += 1;
      }
      const last2 = new Date(y, m, 0).getDate();
      const d2 = Math.min(day, last2);
      const j2 = Date.UTC(y, m - 1, d2, hour, minute, 0);
      target = new Date(j2 - 9 * 60 * 60 * 1000);
    }
    return target;
  }

  const nextRef = nextRefillDate();

  const fmt = (iso) => {
    if (!iso) return "-";
    try {
      return new Date(iso).toLocaleString("ja-JP", { timeZone: tz });
    } catch {
      return iso;
    }
  };

  // ---- このユーザのリクエスト一覧 ----
  const my = (db.data.responses || [])
    .filter(r => r.by?.id === u.id)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const listHtml = (my.length === 0)
    ? `<p class="muted">🤫シーッ、まだここには何もないようです。</p>`
    : `<ul class="list">${
        my.map(r => {
          const state = r.broadcasted
            ? '<span class="badge">放送済み</span>'
            : '<span class="badge gray">未放送</span>';
          const am = r.appleMusicUrl
            ? `<a class="btn f-right" href="${r.appleMusicUrl}" target="_blank" rel="noopener">Apple Music ↗</a>`
            : "";
          const cover = r.artworkUrl
            ? `<img src="${r.artworkUrl}" alt="cover">`
            : `<div style="width:60px;height:60px;border-radius:10px;background:#e5e7eb;"></div>`;
          return `
            <li class="item">
              ${cover}
              <div>
                <div><b>${r.text}</b> <small class="muted">/ ${r.artist || "アーティスト不明"}</small> ${state}</div>
                <div class="muted">${r.createdAt ? new Date(r.createdAt).toLocaleString("ja-JP",{timeZone:tz}) : "-"}</div>
              </div>
              ${am}
            </li>
          `;
        }).join("")
      }</ul>`;

  const html = `<!doctype html><html lang="ja"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>マイページ</title>
  <style>
    :root{
      --bg:#f3f4f6;
      --card:#ffffff;
      --text:#111827;
      --muted:#6b7280;
      --border:#e5e7eb;
      --ok:#10b981;
    }
    body{margin:0;background:linear-gradient(180deg,#eef2f7 0%,#f6f7fb 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial}
    .wrap{max-width:980px;margin:24px auto;padding:0 16px}
    .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin:14px 0;box-shadow:0 6px 18px rgba(16,24,40,.06)}
    .row{display:flex;gap:12px;align-items:center}
    .muted{color:var(--muted)}
    .kv{display:grid;grid-template-columns:160px 1fr;gap:8px 12px;margin-top:12px;align-items:center}
    .list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
    .item{display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 2px 10px rgba(16,24,40,.05)}
    .item img{width:60px;height:60px;border-radius:10px;object-fit:cover}
    .badge{background:var(--ok);color:#fff;border-radius:999px;padding:2px 8px;font-size:12px;margin-left:8px}
    .badge.gray{background:#9ca3af;color:#fff}
    .btn{display:inline-block;padding:8px 12px;border:1px solid #d1d5db;border-radius:10px;text-decoration:none;color:#111827;background:#e5e7eb}
    .btn:hover{background:#dadde2}
    .f-right{margin-left:auto}
    form.settings-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
    form.settings-form input[type="text"]{padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;min-width:160px;}
    form.settings-form button{padding:6px 12px;background:#0070c9;color:#fff;border:none;border-radius:8px;cursor:pointer;}
    .next-remaining{font-size:12px;color:#4b5563;margin-top:2px;}
    .page-head-icon{width:40px;height:40px;object-fit:contain;margin-right:6px;}
    @media(max-width:560px){
      .kv{grid-template-columns:1fr}
      .list{grid-template-columns:1fr}
    }
  </style>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="row">
          <img src="/img/mypage.png" alt="mypage" class="page-head-icon" onerror="this.style.display='none'">
          <div>
            <div style="font-size:18px;font-weight:600;">${u.username} さんのマイページ</div>
            <div class="muted">ID: ${u.id}</div>
          </div>
        </div>
        <div class="kv">
          <b>初回登録</b> <span>${fmt(u.registeredAt)}</span>
          <b>残トークン</b> <span>${isAdmin(u) ? '∞' : (u.tokens ?? 0)}</span>
          <b>最終配布</b> <span>${fmt(u.lastRefillAtISO) || (u.lastRefillISO || "-")}</span>
          <b>次回配布予定</b>
          <span>
            <span id="refillDate">${nextRef.toLocaleString("ja-JP", { timeZone: tz })} (Asia/Tokyo)</span>
            <div id="refillCountdown" class="next-remaining"></div>
          </span>
        </div>
      </div>

      <div class="card">
        <h3>設定</h3>
        <p class="muted">ユーザー名など、このアカウント固有の情報だけ変更できます。</p>
        <form class="settings-form" method="POST" action="/mypage/update">
          <label>ユーザー名:
            <input type="text" name="username" value="${u.username}" maxlength="40" />
          </label>
          <button type="submit">保存する</button>
        </form>
      </div>

      <div class="card">
        <h3>自分の投稿一覧</h3>
        ${listHtml}
      </div>

      <p><a href="/">↩ トップへ戻る</a></p>
    </div>
    <script>
    (function(){
      const el = document.getElementById("refillCountdown");
      const targetIso = ${JSON.stringify(nextRef.toISOString())};
      if (!el || !targetIso) return;
      const target = new Date(targetIso);
      function tick(){
        const now = new Date();
        let diff = Math.floor((target - now)/1000);
        if (diff <= 0){
          el.textContent = "まもなく再配布されます。";
          return;
        }
        const d = Math.floor(diff / 86400); diff -= d*86400;
        const h = Math.floor(diff / 3600); diff -= h*3600;
        const m = Math.floor(diff / 60);
        const s = diff - m*60;
        el.textContent = "残り: " + (d? d+"日 " : "") + String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
        requestAnimationFrame(tick);
      }
      tick();
    })();
    </script>
  </body>
  </html>`;

  res.send(html);
});
app.post("/mypage/update", async (req, res) => {
  if (!req.user) {
    return res.send(toastPage("⚠未ログインです。", "/"));
  }
  await usersDb.read();
  const u = usersDb.data.users.find(x => x.id === req.user.id);
  if (!u) {
    return res.send(toastPage("⚠ユーザーが見つかりませんでした。", "/"));
  }
  const name = (req.body.username ?? "").toString().trim() || "Guest";
  u.username = name;
  await usersDb.write();
return res.send(toastPage(`✅ユーザー名を「${name}」に更新しました。`, "/mypage"));
});



// ---- リクエストを放送済みに ----

// 一括で放送済みに 
app.post("/admin/bulk-broadcast-requests", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const idSet = new Set(ids);
  let touched = false;
  for (const r of db.data.responses) {
    if (idSet.has(r.id)) {
      r.broadcasted = true;
      touched = true;
    }
  }
  if (touched) await db.write();
  res.redirect("/admin");
});

// 一括で未放送へ
app.post("/admin/bulk-unbroadcast-requests", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const idSet = new Set(ids);
  let touched = false;
  for (const r of db.data.responses) {
    if (idSet.has(r.id)) {
      r.broadcasted = false;
      touched = true;
    }
  }
  if (touched) await db.write();
  res.redirect("/admin");
});

app.get("/broadcast/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const item = db.data.responses.find(r => r.id === id);
  if (item) {
    item.broadcasted = true;
    await db.write();
  }
  res.redirect("/admin");
});

// リクエストを未放送に戻す
app.get("/unbroadcast/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const item = db.data.responses.find(r => r.id === id);
  if (item) {
    item.broadcasted = false;
    await db.write();
  }
  res.redirect("/admin");
});

app.listen(PORT, () => console.log(`🚀http://localhost:${PORT}`));

// ---- Boot-time GitHub fetch & periodic persistence ----
try { await fetchAllFromGitHub(false); } catch (e) { console.warn("initial fetchAllFromGitHub failed:", e.message); }
setInterval(() => { syncAllToGitHub(false).catch(e=>console.warn("syncAllToGitHub:", e.message)); }, 60 * 1000); // every 1 min
setInterval(() => { refillAllIfMonthChanged().catch?.(()=>{}); }, 60 * 60 * 1000); // hourly safety check
