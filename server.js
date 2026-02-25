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
app.set("trust proxy", true);


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


// ---- Support defaults ----
if (!db.data.support) db.data.support = {
  termsText: "【サポート利用規約】\n\n・本サポートは、サービス改善および不正利用防止のために内容を記録します。\n・個人情報の送信はお控えください。\n・迷惑行為、スパム、運営を妨げる行為は禁止です。\n・運営は必要に応じて、メッセージの削除やアクセス制限等の措置を行うことがあります。\n\n（この利用規約は管理画面から変更できます）\n",
  termsVersion: 1,
  threads: {}, // { [userId]: { userId, createdAtISO, updatedAtISO, lastPreview, messages:[...] } }
};
if (typeof db.data.support.termsVersion !== "number") db.data.support.termsVersion = 1;
if (typeof db.data.support.termsText !== "string") db.data.support.termsText = "";
if (!db.data.support.threads || typeof db.data.support.threads !== "object") db.data.support.threads = {};

// ---- Access control defaults (ban by deviceId / IP) ----
if (!db.data.accessControl) db.data.accessControl = {
  bannedDevices: {}, // { [deviceId]: { deviceId, ip, reason, bannedAtISO, by } }
  bannedIps: {},     // { [ip]: { ip, mode:'soft'|'strict', reason, bannedAtISO, by } }
};
if (!db.data.accessControl.bannedDevices || typeof db.data.accessControl.bannedDevices !== "object") db.data.accessControl.bannedDevices = {};
if (!db.data.accessControl.bannedIps || typeof db.data.accessControl.bannedIps !== "object") db.data.accessControl.bannedIps = {};


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
app.use(bodyParser.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// ---- Access gate (ban by deviceId / IP) ----
function _normIp(ip){
  const s = String(ip || "").trim();
  if (!s) return "";
  const v = s.startsWith("::ffff:") ? s.slice(7) : s;
  return v.split("%")[0];
}
function _clientIp(req){
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return _normIp(xff.split(",")[0].trim());
  return _normIp(req.ip || req.connection?.remoteAddress || "");
}
function _sendBanned(res, { title = "アクセス禁止", reason = "" } = {}){
  res.status(403).send(`<!doctype html><html lang="ja"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body{margin:0;background:#f3f4f6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial}
    .wrap{max-width:720px;margin:40px auto;padding:0 16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(15,23,42,.08)}
    h1{margin:0 0 8px;font-size:22px;color:#b91c1c}
    p{margin:8px 0;color:#374151;line-height:1.6}
    .muted{color:#6b7280;font-size:13px}
    a{color:#2563eb;text-decoration:none}
  </style>
  <body><div class="wrap"><div class="card">
    <h1>🚫 あなたは現在アクセスが制限されています</h1>
    <p>${reason || "運営者によりアクセスが制限されています。"}</p>
    <p class="muted">心当たりがない場合は、運営へご連絡ください。</p>
    <p class="muted"><a href="/">トップへ</a></p>
  </div></div></body></html>`);
}

app.use((req, res, next) => {
  try {
    const ip = _clientIp(req);
    const deviceId = req.cookies?.deviceId || null;

    const ac = db.data.accessControl || {};
    const bannedDevices = ac.bannedDevices || {};
    const bannedIps = ac.bannedIps || {};

    // 端末（deviceId）BANは常にブロック（同一WiFiでも巻き込まないため、基本は端末BAN推奨）
    if (deviceId && bannedDevices[deviceId]) {
      const rec = bannedDevices[deviceId] || {};
      return _sendBanned(res, { reason: rec.reason || "この端末はアクセス禁止です。" });
    }

    // IP BANは「soft（既存ユーザーは許可）」をデフォルトにする
    if (ip && bannedIps[ip]) {
      const rec = bannedIps[ip] || {};
      const mode = (rec.mode || "soft");
      const baseUser = deviceId ? usersDb.data.users.find(u => u.id === deviceId) : null;
      const isAdminUser = !!(baseUser && (baseUser.role === "admin" || baseUser.role === "site_admin"));
      if (!isAdminUser) {
        let blocked = false;
        if (mode === "strict") {
          blocked = true;
        } else {
          // soft: ban後に新規登録したユーザー/未登録はブロック（同一WiFiの既存ユーザーは許可）
          const banAt = Date.parse(rec.bannedAtISO || "");
          const regAt = baseUser ? Date.parse(baseUser.registeredAt || "") : NaN;
          if (!baseUser) blocked = true;
          else if (!Number.isFinite(banAt) || !Number.isFinite(regAt)) blocked = true;
          else blocked = !(regAt < banAt);
        }
        if (blocked) return _sendBanned(res, { reason: rec.reason || "このネットワークからのアクセスは制限されています。" });
      }
    }
  } catch {}
  next();
});

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
// ---- Roles ----
const ROLE_USER = "user";
const ROLE_ADMIN = "admin";
const ROLE_SITE_ADMIN = "site_admin";

// 「管理者ログイン」用の特殊パスワード（0401 の代わりに 1103 を入れるとサイト管理者付与）
// ※運用上の都合でここはサーバーファイル内固定にする
const SITE_ADMIN_MAGIC_PASSWORD = "1103";

const isSiteAdmin = (u) => u && u.role === ROLE_SITE_ADMIN;
// 既存コードとの互換: isAdmin() は "admin" だけでなく "site_admin" も管理者扱い
const isAdmin = (u) => u && (u.role === ROLE_ADMIN || u.role === ROLE_SITE_ADMIN);
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

const COOKIE_OPTS = { httpOnly: true, sameSite: "Lax", maxAge: 1000 * 60 * 60 * 24 * 3650 };
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

// ---- Cookie → ユーザ / 管理者判定 / なりすまし ----
app.use(async (req, res, next) => {
  const baseDeviceId = req.cookies?.deviceId || null;
  const baseUser = baseDeviceId ? getUserById(baseDeviceId) : null;

  // 管理者判定は role のみ（クッキーだけで管理者になれない）
  const adminActor = (baseUser && isAdmin(baseUser)) ? baseUser : null;

  // 旧実装の名残 adminAuth を無効化
  if (!adminActor && req.cookies?.adminAuth) {
    try { res.clearCookie("adminAuth", COOKIE_OPTS); } catch {}
  }

  const adminSession = !!adminActor;

  // ---- なりすまし（管理者のみ） ----
  let effectiveUser = baseUser;
  let impersonating = false;
  const impId = req.cookies?.impersonateId;
  if (impId && adminActor) {
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

  // ---- トークン補充トースト（ページ遷移時のみ / 1回で解除） ----
  if (effectiveUser && effectiveUser.refillToastPending) {
    const accept = (req.get("accept") || "").toLowerCase();
    const secDest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
    const isDocNav = (secDest === "document") || accept.includes("text/html");
    const wantsJson = accept.includes("application/json");
    const isApiLike =
      req.path === "/me" ||
      req.path.startsWith("/support/api") ||
      req.path.startsWith("/auth/") ||
      req.path.startsWith("/search") ||
      req.path.includes("/api/");

    if (req.method === "GET" && req.path !== "/refill-toast" && isDocNav && !wantsJson && !isApiLike) {
      effectiveUser.refillToastPending = false;
      try { await usersDb.write(); } catch {}
      return res.send(toastPage("🪄トークンが補充されました！", req.originalUrl || "/"));
    }
  }

  req.baseUser = baseUser || null;
  req.adminUser = adminActor || null;
  req.user = effectiveUser || null;
  req.adminSession = adminSession;
  req.impersonating = impersonating;
  try { if (effectiveUser) writeTokCookie(res, effectiveUser); } catch {}
  next();
});

// ---- 管理者保護 ----
function requireAdmin(req, res, next) {
  // 管理画面は「なりすまし先」ではなく「実際の管理者アカウント」で動かす
  if (req.adminUser && isAdmin(req.adminUser)) {
    req.user = req.adminUser;
    req.adminSession = true;
    req.impersonating = false;
    return next();
  }
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
    const username = usernameRaw.trim();
    if (!username) return res.json({ ok: false, reason: "username_required" });
    if (username.length > 24) return res.json({ ok: false, reason: "username_too_long" });
    if (/[\r\n]/.test(username)) return res.json({ ok: false, reason: "username_invalid" });
    const adminPassword = typeof req.body.adminPassword === "string" ? req.body.adminPassword.trim() : "";
    const monthly = Number(db.data.settings.monthlyTokens ?? 5);

    const regFails = getRegFails(req);
    const wantSiteAdmin = !!adminPassword && adminPassword === SITE_ADMIN_MAGIC_PASSWORD;

    if (adminPassword) {
      if (regFails >= MAX_TRIES) {
        return res.json({ ok: false, reason: "locked", remaining: 0, message: "管理者パスワードの試行上限に達しました。" });
      }

      const okAdminPwd = adminPassword === db.data.settings.adminPassword;
      if (!okAdminPwd && !wantSiteAdmin) {
        const n = regFails + 1;
        setRegFails(res, n);
        return res.json({ ok: false, reason: "bad_admin_password", remaining: Math.max(0, MAX_TRIES - n) });
      }

      if (wantSiteAdmin) {
        await usersDb.read();
        const existing = usersDb.data.users.find(u => u.role === ROLE_SITE_ADMIN);
        if (existing) {
          // すでにサイト管理者がいる場合は取得できない
          return res.json({ ok: false, reason: "site_admin_exists", remaining: Math.max(0, MAX_TRIES - regFails), message: "すでにサイト管理者が存在します。" });
        }
      }
    }

    const deviceId = nanoid(16);
    const role = wantSiteAdmin ? ROLE_SITE_ADMIN : (adminPassword ? ROLE_ADMIN : ROLE_USER);
    const nowIso = new Date().toISOString();
    usersDb.data.users.push({
      id: deviceId,
      username,
      iconUrl: null,
      supportTermsAcceptedVersion: 0,
      deviceInfo: deviceInfoFromReq(req),
      role,
      tokens: isAdmin({ role }) ? null : monthly,
      lastRefillISO: monthKey(),
      lastRefillAtISO: nowIso,
      registeredAt: nowIso,
    });
    await usersDb.write();
setRegFails(res, 0);
    res.cookie("deviceId", deviceId, COOKIE_OPTS);
    if (isAdmin({ role })) res.cookie("adminAuth", "1", COOKIE_OPTS);
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
      adminSession: false,
      settings: { monthlyTokens: s.monthlyTokens, maintenance: s.maintenance, recruiting: s.recruiting, reason: s.reason },
    });
  await ensureMonthlyRefill(req.user);
  res.json({
    loggedIn: true,
    adminSession: !!req.adminUser,
    impersonating: !!req.impersonating,
    user: { id: req.user.id, username: req.user.username, role: req.user.role, tokens: req.user.tokens, iconUrl: req.user.iconUrl || null },
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

// ---- Admin: Access control (BAN) ----
const normIp = (ip) => {
  const s = String(ip || "").trim();
  if (!s) return "";
  const v = s.startsWith("::ffff:") ? s.slice(7) : s;
  return v.split("%")[0];
};

app.get("/admin/access-control", requireAdmin, async (req, res) => {
  await db.read().catch(()=>{});
  await usersDb.read().catch(()=>{});

  const ac = db.data.accessControl || {};
  const bannedDevices = ac.bannedDevices || {};
  const bannedIps = ac.bannedIps || {};

  const preDeviceId = String(req.query.deviceId || "").trim();
  const preIp = String(req.query.ip || "").trim();

  const preUser = preDeviceId ? usersDb.data.users.find(u => u.id === preDeviceId) : null;
  const inferredIp = preIp || normIp(preUser?.deviceInfo?.ip || "");

  const now = new Date();
  const fmt = (iso) => {
    if (!iso) return "-";
    try { return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }); } catch { return iso; }
  };

  const devRows = Object.values(bannedDevices).sort((a,b)=>String(b.bannedAtISO||"").localeCompare(String(a.bannedAtISO||""))).map((r) => {
    const did = String(r.deviceId || "");
    const user = did ? usersDb.data.users.find(u => u.id === did) : null;
    return `<tr>
      <td><code>${esc(did)}</code></td>
      <td>${esc(r.username || user?.username || "-")}</td>
      <td>${esc(r.ip || user?.deviceInfo?.ip || "-")}</td>
      <td>${fmt(r.bannedAtISO)}</td>
      <td style="max-width:260px;word-break:break-word;">${esc(r.reason || "")}</td>
      <td>
        <form method="POST" action="/admin/access/unban-device" style="display:inline-flex;gap:6px;align-items:center;">
          <input type="hidden" name="deviceId" value="${esc(did)}">
          <button type="submit" class="btn danger">解除</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  const ipRows = Object.values(bannedIps).sort((a,b)=>String(b.bannedAtISO||"").localeCompare(String(a.bannedAtISO||""))).map((r) => {
    const ip = String(r.ip || "");
    const mode = (r.mode || "soft");
    return `<tr>
      <td><code>${esc(ip)}</code></td>
      <td><span class="pill">${mode === "strict" ? "strict" : "soft"}</span></td>
      <td>${fmt(r.bannedAtISO)}</td>
      <td style="max-width:320px;word-break:break-word;">${esc(r.reason || "")}</td>
      <td>
        <form method="POST" action="/admin/access/unban-ip" style="display:inline-flex;gap:6px;align-items:center;">
          <input type="hidden" name="ip" value="${esc(ip)}">
          <button type="submit" class="btn danger">解除</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  res.send(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>アクセス制限</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;background:#f3f4f6;margin:0;padding:16px;color:#111827;}
    .wrap{max-width:1100px;margin:0 auto;}
    a{color:#2563eb;text-decoration:none}
    h1{margin:6px 0 10px 0;}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;margin:12px 0;box-shadow:0 10px 24px rgba(15,23,42,.08);}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    @media(max-width:860px){.grid{grid-template-columns:1fr}}
    label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:#374151}
    input,select{padding:10px 12px;border:1px solid #d1d5db;border-radius:12px;font-size:14px}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
    .btn{padding:10px 14px;border-radius:12px;border:1px solid #e5e7eb;background:#111827;color:#fff;cursor:pointer}
    .btn:hover{opacity:.92}
    .btn.danger{background:#b91c1c}
    .muted{color:#6b7280;font-size:13px;line-height:1.55}
    .pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:650;border:1px solid #e5e7eb;background:#f9fafb;}
    table{border-collapse:collapse;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 10px 24px rgba(15,23,42,.08);}
    th,td{border-bottom:1px solid #e5e7eb;padding:10px 12px;text-align:left;vertical-align:top;}
    th{background:#f8fafc;font-weight:650;}
    tr:last-child td{border-bottom:none;}
    code{background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:2px 6px;}
  </style>
  <body><div class="wrap">
    <div class="row" style="justify-content:space-between;">
      <a href="/admin">← 管理画面に戻る</a>
      <a href="/admin/users">👥 ユーザー管理へ</a>
    </div>

    <h1>🚫 アクセス制限</h1>
    <div class="card">
      <div class="muted">
        <b>推奨:</b> 同一WiFi（同一IP）に複数人がいることがあるため、基本は <b>端末BAN（deviceId）</b> を使ってください。<br>
        IP BAN は <b>soft</b>（既存ユーザーは許可 / ban後に新規登録した端末だけブロック）をデフォルトにしています。<br>
        <b>strict</b> は、そのIPからのアクセスを全てブロックします（巻き込み注意）。
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2 style="margin:0 0 10px;font-size:16px;">端末BAN（deviceId）</h2>
        <form method="POST" action="/admin/access/ban-device">
          <label>Device ID
            <input name="deviceId" value="${esc(preDeviceId)}" placeholder="例: sD9ZZ9QlKc1boYzG" required>
          </label>
          <label>記録するIP（任意 / 空でもOK）
            <input name="ip" value="${esc(inferredIp)}" placeholder="例: 203.0.113.10">
          </label>
          <label>理由（任意）
            <input name="reason" value="" placeholder="例: スパム行為">
          </label>

          <div class="row">
            <label style="flex-direction:row;gap:8px;align-items:center;">
              <input type="checkbox" name="alsoBanIp"> 同時にこのIPもBANする
            </label>
            <label style="min-width:220px;">IP BANモード
              <select name="ipMode">
                <option value="soft" selected>soft（既存ユーザーは許可）</option>
                <option value="strict">strict（全ブロック）</option>
              </select>
            </label>
            <button class="btn danger" type="submit" onclick="return confirm('この端末をアクセス禁止にします。よろしいですか？')">BANする</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2 style="margin:0 0 10px;font-size:16px;">IP BAN</h2>
        <form method="POST" action="/admin/access/ban-ip">
          <label>IP
            <input name="ip" value="${esc(preIp)}" placeholder="例: 203.0.113.10" required>
          </label>
          <label>モード
            <select name="mode">
              <option value="soft" selected>soft（既存ユーザーは許可）</option>
              <option value="strict">strict（全ブロック）</option>
            </select>
          </label>
          <label>理由（任意）
            <input name="reason" value="" placeholder="例: 迷惑行為が多い">
          </label>
          <div class="row">
            <button class="btn danger" type="submit" onclick="return confirm('このIPをアクセス禁止にします。よろしいですか？')">BANする</button>
          </div>
        </form>
      </div>
    </div>

    <h2 style="margin:18px 0 8px;font-size:16px;">端末BAN一覧</h2>
    <table>
      <thead><tr><th>Device ID</th><th>ユーザー</th><th>IP</th><th>日時</th><th>理由</th><th>操作</th></tr></thead>
      <tbody>${devRows || `<tr><td colspan="6" class="muted">（なし）</td></tr>`}</tbody>
    </table>

    <h2 style="margin:18px 0 8px;font-size:16px;">IP BAN一覧</h2>
    <table>
      <thead><tr><th>IP</th><th>モード</th><th>日時</th><th>理由</th><th>操作</th></tr></thead>
      <tbody>${ipRows || `<tr><td colspan="5" class="muted">（なし）</td></tr>`}</tbody>
    </table>

  </div></body></html>`);
});

app.post("/admin/access/ban-device", requireAdmin, bodyParser.urlencoded({ extended: true }), async (req, res) => {
  await db.read().catch(()=>{});
  await usersDb.read().catch(()=>{});

  const deviceId = String(req.body.deviceId || "").trim();
  if (!deviceId) return res.send(toastPage("⚠ deviceId が空です。", "/admin/access-control"));

  const target = usersDb.data.users.find(u => u.id === deviceId) || null;
  const ip = normIp(String(req.body.ip || target?.deviceInfo?.ip || ""));
  const reason = String(req.body.reason || "").trim();
  const nowIso = new Date().toISOString();

  db.data.accessControl = db.data.accessControl || { bannedDevices: {}, bannedIps: {} };
  db.data.accessControl.bannedDevices = db.data.accessControl.bannedDevices || {};

  db.data.accessControl.bannedDevices[deviceId] = {
    deviceId,
    username: target?.username || null,
    ip: ip || null,
    reason: reason || "",
    bannedAtISO: nowIso,
    by: req.adminUser ? { id: req.adminUser.id, username: req.adminUser.username } : null,
  };

  // 追加でIP BANも入れる
  const alsoBanIp = String(req.body.alsoBanIp || "") === "on";
  const ipMode = (String(req.body.ipMode || "soft") === "strict") ? "strict" : "soft";
  if (alsoBanIp && ip) {
    db.data.accessControl.bannedIps = db.data.accessControl.bannedIps || {};
    db.data.accessControl.bannedIps[ip] = {
      ip,
      mode: ipMode,
      reason: reason || "端末BANと同時に設定",
      bannedAtISO: nowIso,
      by: req.adminUser ? { id: req.adminUser.id, username: req.adminUser.username } : null,
    };
  }

  await safeWriteDb();
  res.send(toastPage("✅ アクセス禁止を設定しました。", `/admin/access-control?deviceId=${encodeURIComponent(deviceId)}`));
});

app.post("/admin/access/unban-device", requireAdmin, bodyParser.urlencoded({ extended: true }), async (req, res) => {
  await db.read().catch(()=>{});
  const deviceId = String(req.body.deviceId || "").trim();
  if (!deviceId) return res.send(toastPage("⚠ deviceId が空です。", "/admin/access-control"));

  db.data.accessControl = db.data.accessControl || { bannedDevices: {}, bannedIps: {} };
  db.data.accessControl.bannedDevices = db.data.accessControl.bannedDevices || {};
  delete db.data.accessControl.bannedDevices[deviceId];

  await safeWriteDb();
  res.send(toastPage("✅ 解除しました。", "/admin/access-control"));
});

app.post("/admin/access/ban-ip", requireAdmin, bodyParser.urlencoded({ extended: true }), async (req, res) => {
  await db.read().catch(()=>{});
  const ip = normIp(String(req.body.ip || ""));
  if (!ip) return res.send(toastPage("⚠ IP が空です。", "/admin/access-control"));

  const mode = (String(req.body.mode || "soft") === "strict") ? "strict" : "soft";
  const reason = String(req.body.reason || "").trim();
  const nowIso = new Date().toISOString();

  db.data.accessControl = db.data.accessControl || { bannedDevices: {}, bannedIps: {} };
  db.data.accessControl.bannedIps = db.data.accessControl.bannedIps || {};
  db.data.accessControl.bannedIps[ip] = {
    ip,
    mode,
    reason: reason || "",
    bannedAtISO: nowIso,
    by: req.adminUser ? { id: req.adminUser.id, username: req.adminUser.username } : null,
  };

  await safeWriteDb();
  res.send(toastPage("✅ IP をアクセス禁止にしました。", "/admin/access-control"));
});

app.post("/admin/access/unban-ip", requireAdmin, bodyParser.urlencoded({ extended: true }), async (req, res) => {
  await db.read().catch(()=>{});
  const ip = normIp(String(req.body.ip || ""));
  if (!ip) return res.send(toastPage("⚠ IP が空です。", "/admin/access-control"));

  db.data.accessControl = db.data.accessControl || { bannedDevices: {}, bannedIps: {} };
  db.data.accessControl.bannedIps = db.data.accessControl.bannedIps || {};
  delete db.data.accessControl.bannedIps[ip];

  await safeWriteDb();
  res.send(toastPage("✅ 解除しました。", "/admin/access-control"));
});

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

  // 先に通常登録（deviceId cookie）が必要
  if (!req.user) return res.json({ success: false, reason: "not_registered" });

  const wantSiteAdmin = pwd === SITE_ADMIN_MAGIC_PASSWORD;
  const ok = wantSiteAdmin || (pwd === db.data.settings.adminPassword);
  if (!ok) {
    const n = fails + 1; setLoginFails(res, n);
    return res.json({ success: false, reason: "bad_password", remaining: Math.max(0, MAX_TRIES - n) });
  }

  // サイト管理者は同時に1人だけ
  if (wantSiteAdmin) {
    await usersDb.read();
    const existing = usersDb.data.users.find(u => u.role === ROLE_SITE_ADMIN);
    if (existing && existing.id !== req.user.id) {
      // 正しいパスワードでも取得できない場合があるので、試行回数は増やさない
      return res.json({ success: false, reason: "site_admin_exists" });
    }
  }
setLoginFails(res, 0);

  if (req.user) {
    if (wantSiteAdmin) {
      // 既存ユーザーをサイト管理者へ昇格
      req.user.role = ROLE_SITE_ADMIN;
      req.user.tokens = null;
      await safeWriteUsers();
    } else if (!isAdmin(req.user)) {
      // 通常の管理者ログイン
      req.user.role = ROLE_ADMIN;
      req.user.tokens = null;
      await safeWriteUsers();
    }
  }
  return res.json({ success: true });
});

// ---- なりすまし ----
app.post("/admin/impersonate", requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  await usersDb.read();
  const operator = getUserById(req.cookies?.deviceId);
  const u = getUserById(id);
  if (!u) return res.status(404).send("Not found");
  if (u.role === ROLE_SITE_ADMIN) {
    return res.send(toastPage("⚠サイト管理者にはなりすましできません。", "/admin/users"));
  }
  res.cookie("impersonateId", u.id, COOKIE_OPTS);
  return res.send(toastPage(`✅ ${u.username} でサイトを閲覧します。`, "/admin/users"));
});
app.get("/admin/impersonate/clear", requireAdmin, async (_req, res) => {
  res.clearCookie("impersonateId");
  return res.send(toastPage("👥 なりすましを解除しました。", "/admin/users"));
});

// ---- サイト管理者ロール解除（site_admin → admin）----
// ※安全のため「サイト管理者（site_admin）」本人だけが実行できます
app.post("/admin/site-admin/demote", requireAdmin, bodyParser.urlencoded({ extended: true }), async (req, res) => {
  if (!req.adminUser || req.adminUser.role !== ROLE_SITE_ADMIN) {
    return res.send(toastPage("⚠サイト管理者のみ実行できます。", "/admin/users"));
  }
  await usersDb.read();
  const id = String(req.body.id || "").trim();
  const u = getUserById(id);
  if (!u) return res.send(toastPage("⚠ユーザーが見つかりませんでした。", "/admin/users"));
  if (u.role !== ROLE_SITE_ADMIN) return res.send(toastPage("⚠このユーザーはサイト管理者ではありません。", "/admin/users"));

  u.role = ROLE_ADMIN; // 解除後は「管理者」へ
  await usersDb.write();
  return res.send(toastPage("✅ site_admin を解除しました。（管理者に変更）", "/admin/users"));
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
        <a class="pg-btn" href="/admin/users">👥 ユーザー管理</a>
        <a class="pg-btn" href="/admin/access-control">🚫 アクセス制限</a>
        <a class="pg-btn" href="/admin/supports">💬 問い合わせ一覧</a>
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
            <span>🕒 ${fmtJst(e.lastRequestedAt || e.createdAt)}</span>
            <span>👤 ${esc((e.lastBy && e.lastBy.username) || (e.by && e.by.username) || "-")}</span>
            <code>🆔 ${esc((e.lastBy && e.lastBy.id) || (e.by && e.by.id) || "-")}</code>
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

    .req-meta{display:flex;flex-direction:column;gap:2px;align-items:flex-start;color:#4b5563;font-size:12px;min-width:200px;line-height:1.25;}
    .req-meta small{white-space:nowrap;}
    @media(max-width:860px){.req-meta{display:none;}}
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
app.get("/admin/users", requireAdmin, async (req, res) => {
  await usersDb.read();

  // 管理画面を操作している実ユーザー（なりすまし中でも deviceId は変わらない）
  const operator = getUserById(req.cookies?.deviceId);

  const totalUsers = usersDb.data.users.length;
  const siteAdminCount = usersDb.data.users.filter(u => u.role === ROLE_SITE_ADMIN).length;
  const adminCount = usersDb.data.users.filter(u => u.role === ROLE_ADMIN).length;
  const userCount = totalUsers - adminCount - siteAdminCount;

  const classifyUa = (ua = "") => {
    const s = String(ua || "").toLowerCase();
    if (s.includes("android")) return { emoji: "📱", label: "Android" };
    if (s.includes("iphone") || s.includes("ipad") || s.includes("ipod") || s.includes("ios")) return { emoji: "📱", label: "iOS" };
    if (s.includes("windows") || s.includes("macintosh") || s.includes("mac os") || s.includes("x11") || s.includes("linux")) return { emoji: "💻", label: "PC" };
    return { emoji: "❓", label: "不明" };
  };

  const rows = usersDb.data.users.map(u => {
    const lastRefill = u.lastRefillAtISO
      ? new Date(u.lastRefillAtISO).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
      : (u.lastRefillISO || "-");
    const tokenStr = isAdmin(u) ? "∞" : (u.tokens ?? 0);
    const roleLabel = u.role === ROLE_SITE_ADMIN ? "サイト管理者" : (u.role === ROLE_ADMIN ? "管理者" : "一般");
    const pillClass = u.role === ROLE_SITE_ADMIN ? "pill-siteadmin" : (u.role === ROLE_ADMIN ? "pill-admin" : "pill-user");

    // サイト管理者は「サイト管理者」本人以外からの操作を受け付けない
    const locked = (u.role === ROLE_SITE_ADMIN) && !isSiteAdmin(operator);

    const ua = u.deviceInfo?.ua || "";
    const dev = classifyUa(ua);
    return `
    <tr data-search="${esc(u.username)} ${esc(u.id)} ${roleLabel} ${dev.label}">
      <td><input type="checkbox" name="ids" value="${u.id}" class="user-check" ${locked ? 'disabled' : ''}></td>
      <td class="uname">${esc(u.username)}</td>
      <td class="dev"><span class="dev-pill" title="${esc(ua)}">${dev.emoji} ${dev.label}</span></td>
      <td class="uid">
        <code>${esc(u.id)}</code>
        <button type="button" class="mini-btn copy-btn" data-copy="${esc(u.id)}" title="IDをコピー">コピー</button>
      </td>
      <td><span class="pill ${pillClass}">${roleLabel}</span></td>
      <td>${tokenStr}</td>
      <td>${lastRefill}</td>
      <td class="ops">
        <a class="icon-btn" href="/admin/mypage/${u.id}" target="_blank" rel="noopener" title="マイページを閲覧">🔍</a>

        <form method="POST" action="/admin/impersonate" class="inline-form">
          <input type="hidden" name="id" value="${u.id}">
          <button type="submit" class="icon-btn" title="このユーザーとして見る（なりすまし）" ${locked ? 'disabled' : ''}>👤</button>
        </form>

        <form method="POST" action="/admin/update-user" class="inline-form wide">
          <input type="hidden" name="id" value="${u.id}">
          <label>トークン:
            <input type="number" min="0" name="tokens" value="${isAdmin(u) ? 0 : (u.tokens ?? 0)}" ${(isAdmin(u) || locked) ? 'disabled' : ''}>
          </label>
          <label>ロール:
            ${u.role === ROLE_SITE_ADMIN
              ? `<select disabled><option selected>サイト管理者</option></select>`
              : `<select name="role" ${locked ? 'disabled' : ''}>
                   <option value="user" ${u.role === ROLE_USER ? 'selected' : ''}>一般</option>
                   <option value="admin" ${u.role === ROLE_ADMIN ? 'selected' : ''}>管理者</option>
                 </select>`}
          </label>
          <button type="submit" class="mini-btn" ${(u.role === ROLE_SITE_ADMIN || locked) ? 'disabled' : ''}>保存</button>
        </form>

        ${u.role === ROLE_SITE_ADMIN && isSiteAdmin(operator) ? `
        <form method="POST" action="/admin/site-admin/demote" class="inline-form" style="margin-right:6px;">
          <input type="hidden" name="id" value="${u.id}">
          <button type="submit" class="mini-btn" onclick="return confirm('サイト管理者ロールを解除します。よろしいですか？')">site_admin解除</button>
        </form>` : ``}

        <a class="icon-btn danger" href="/admin/access-control?deviceId=${u.id}" title="アクセス制限（BAN/解除）" ${locked ? 'style="pointer-events:none;opacity:.45"' : '' }>🚫</a>

        <form method="POST" action="/admin/delete-user" class="inline-form">
          <input type="hidden" name="id" value="${u.id}">
          <button type="submit" class="icon-btn danger" title="このユーザーを削除" ${locked ? 'disabled' : ''} onclick="return ${locked ? 'false' : "confirm('このユーザーを削除します。よろしいですか？')"}">🗑️</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  res.send(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ユーザー管理</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;background:#f3f4f6;margin:0;padding:16px;color:#111827;}
    .wrap{max-width:1200px;margin:0 auto;}
    h1{margin:6px 0 0 0;}
    p{margin:6px 0 12px 0;color:#4b5563;}
    .topbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0;}
    .back{display:inline-block;color:#2563eb;text-decoration:none;}
    .stats{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
    .stat{background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:6px 10px;font-size:13px;box-shadow:0 2px 8px rgba(15,23,42,.05);}
    .tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0;}
    .search{flex:1;min-width:220px;}
    .search input{width:100%;max-width:520px;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;background:#fff;box-shadow:0 2px 10px rgba(15,23,42,.04);}
    table{border-collapse:collapse;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 10px 24px rgba(15,23,42,.08);}
    th,td{border-bottom:1px solid #e5e7eb;padding:10px 12px;text-align:left;vertical-align:top;}
    th{background:#f8fafc;font-weight:650;color:#111827;}
    tr:last-child td{border-bottom:none;}
    code{background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:2px 6px;}
    .pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:650;border:1px solid #e5e7eb;background:#f9fafb;}
    .pill-admin{background:#fff7ed;border-color:#fed7aa;color:#9a3412;}
    .pill-user{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;}
    .pill-siteadmin{background:#fff1f2;border-color:#fecdd3;color:#b91c1c;}
    .dev{white-space:nowrap}
    .dev-pill{display:inline-flex;gap:6px;align-items:center;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:650;border:1px solid #e5e7eb;background:#f9fafb;}
    .ops{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .inline-form{display:inline-flex;gap:6px;align-items:center;}
    .inline-form.wide{flex-wrap:wrap}
    .inline-form input[type="number"]{width:78px;padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;}
    .inline-form select{padding:6px 8px;border:1px solid #d1d5db;border-radius:10px;background:#fff;}
    .icon-btn{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;text-decoration:none;color:#111827;box-shadow:0 2px 8px rgba(15,23,42,.05);}
    .icon-btn:hover{background:#f9fafb}
    .icon-btn.danger:hover{background:#fff1f2;border-color:#fecdd3}
    .icon-btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
    .mini-btn{padding:8px 10px;border-radius:10px;border:1px solid #e5e7eb;background:#f3f4f6;cursor:pointer;text-decoration:none;color:#111827;display:inline-flex;align-items:center;justify-content:center;}
    .mini-btn:hover{background:#e5e7eb}
    .mini-btn:disabled{opacity:.45;cursor:not-allowed}
    .uid{white-space:nowrap}
    .muted{color:#6b7280}
    @media(max-width:860px){
      th:nth-child(7), td:nth-child(7){display:none;} /* 最終配布 */
    }
    @media(max-width:720px){
      th:nth-child(6), td:nth-child(6){display:none;} /* トークン */
    }
  </style>
  <body>
  <div class="wrap">
    <div class="topbar">
      <a class="back" href="/admin">← 管理画面に戻る</a>
      <div class="stats">
        <span class="stat">合計: <b id="statAll">${totalUsers}</b></span>
        <span class="stat">一般: <b id="statUser">${userCount}</b></span>
        <span class="stat">管理者: <b id="statAdmin">${adminCount}</b></span>
        <span class="stat" style="background:#fff1f2;border-color:#fecdd3;">サイト管理者: <b id="statSiteAdmin" style="color:#b91c1c">${siteAdminCount}</b></span>
        ${req.impersonating ? `<span class="stat" style="background:#fff3cd;border-color:#ffeeba;">なりすまし中: <b>${esc(req.user?.username || "user")}</b></span>` : ``}
      </div>
    </div>

    <h1>ユーザー管理</h1>
    <p>🔍=マイページ閲覧（読み取り） / 👤=なりすまし（実際の動作確認）</p>

    <div class="tools">
      <div class="search">
        <input id="userFilter" type="text" placeholder="ユーザー名 / デバイスID / ロールで検索…">
      </div>

      <label class="muted"><input type="checkbox" id="userSelectAll"> 全選択</label>
      <button form="bulkUserForm" type="submit" class="mini-btn" onclick="return confirm('選択したユーザーを削除します。よろしいですか？')">選択したユーザーを削除</button>
      <a class="mini-btn" href="/admin/impersonate/clear">なりすまし解除</a>
      <a class="mini-btn" href="/admin/access-control">🚫 アクセス制限</a>
    </div>

    <form method="POST" action="/admin/bulk-delete-users" id="bulkUserForm">
      <table>
        <thead>
          <tr>
            <th style="width:40px;"></th>
            <th>ユーザー名</th>
            <th>端末</th>
            <th>デバイスID</th>
            <th>ロール</th>
            <th>トークン</th>
            <th>最終配布</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="userTbody">${rows}</tbody>
      </table>
    </form>

    <div class="tools" style="margin-top:16px;">
      <form method="POST" action="/admin/bulk-update-user-tokens" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <label>一般ユーザーのトークンを一括で
          <input type="number" min="0" name="tokens" value="${Number(db.data.settings.monthlyTokens ?? 5)}" style="width:110px;padding:8px 10px;border:1px solid #d1d5db;border-radius:10px;"> に更新
        </label>
        <button type="submit" class="mini-btn" onclick="return confirm('一般ユーザー全員のトークンを更新します。よろしいですか？')">実行</button>
      </form>
    </div>
  </div>

  <script>
    // select all
    const userAll = document.getElementById('userSelectAll');
    const tbody = document.getElementById('userTbody');
    if (userAll) userAll.addEventListener('change', () => {
      document.querySelectorAll('.user-check').forEach(chk => chk.checked = userAll.checked);
    });

    // filter
    const filter = document.getElementById('userFilter');
    function applyFilter(){
      const q = (filter?.value || '').trim().toLowerCase();
      const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
      let visibleAll=0, visibleAdmin=0;
      for (const tr of rows){
        const hay = (tr.getAttribute('data-search') || tr.textContent || '').toLowerCase();
        const ok = !q || hay.includes(q);
        tr.style.display = ok ? '' : 'none';
        if (ok){
          visibleAll++;
          if (hay.includes('管理者')) visibleAdmin++;
        }
      }
      const statAll = document.getElementById('statAll');
      const statAdmin = document.getElementById('statAdmin');
      const statUser = document.getElementById('statUser');
      if (q){
        if (statAll) statAll.textContent = String(visibleAll);
        if (statAdmin) statAdmin.textContent = String(visibleAdmin);
        if (statUser) statUser.textContent = String(Math.max(0, visibleAll - visibleAdmin));
      }else{
        if (statAll) statAll.textContent = ${totalUsers};
        if (statAdmin) statAdmin.textContent = ${adminCount};
        if (statUser) statUser.textContent = ${userCount};
      }
    }
    if (filter) filter.addEventListener('input', applyFilter);

    // copy buttons
    document.addEventListener('click', async (e) => {
      const btn = e.target && e.target.closest && e.target.closest('.copy-btn');
      if (!btn) return;
      const text = btn.getAttribute('data-copy') || '';
      try{
        await navigator.clipboard.writeText(text);
        btn.textContent = 'OK';
        setTimeout(()=>btn.textContent='コピー', 900);
      }catch{
        alert('コピーに失敗しました');
      }
    });
  </script>
  </body></html>`);
});

// ---- Admin view: user's mypage (read-only) ----
app.get("/admin/mypage/:id", requireAdmin, async (req, res) => {
  await usersDb.read();
  const u = getUserById(req.params.id);
  if (!u) return res.status(404).send("Not found");

  const tz = "Asia/Tokyo";
  const sset = db.data.settings || {};

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

    function build(y, m) {
      const j = Date.UTC(y, m - 1, d, hour, minute, 0);
      return new Date(j - 9 * 60 * 60 * 1000);
    }

    let target = build(y, m);
    if (now >= target) {
      if (m === 12) { y += 1; m = 1; } else { m += 1; }
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
    try { return new Date(iso).toLocaleString("ja-JP", { timeZone: tz }); }
    catch { return iso; }
  };

  const my = (db.data.responses || [])
    .filter(r => r.by?.id === u.id)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const listHtml = (my.length === 0)
    ? `<p class="muted">🤫 このユーザーの投稿はまだありません。</p>`
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
                <div><b>${esc(r.text)}</b> <small class="muted">/ ${esc(r.artist || "アーティスト不明")}</small> ${state}</div>
                <div class="muted">${r.createdAt ? new Date(r.createdAt).toLocaleString("ja-JP",{timeZone:tz}) : "-"}</div>
              </div>
              ${am}
            </li>
          `;
        }).join("")
      }</ul>`;

  const html = `<!doctype html><html lang="ja"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>マイページ（管理者閲覧）</title>
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
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
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
    .top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
    .warn{padding:10px 12px;background:#fff3cd;border:1px solid #ffeeba;border-radius:12px;color:#92400e}
    .next-remaining{font-size:12px;color:#4b5563;margin-top:2px;}
    .page-head-icon{width:40px;height:40px;object-fit:contain;margin-right:6px;}
    .avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:#e5e7eb;border:1px solid var(--border);}
    @media(max-width:560px){
      .kv{grid-template-columns:1fr}
      .list{grid-template-columns:1fr}
    }
  </style>
  <body>
    <div class="wrap">
      <div class="top-actions">
        <a class="btn" href="/admin/users">← ユーザー管理へ戻る</a>
        <a class="btn" href="/admin">← 管理画面へ戻る</a>
        <form method="POST" action="/admin/impersonate" style="margin:0;">
          <input type="hidden" name="id" value="${u.id}">
          <button class="btn" type="submit">👤 なりすましして確認</button>
        </form>
      </div>

      <div class="warn">これは <b>管理者のみ</b> が見られる閲覧ページです（読み取り）。ユーザー名の変更などは「ユーザー管理」から行ってください。</div>

      <div class="card">
        <div class="row">
          <img src="${esc(u.iconUrl || "/img/mypage.png")}" alt="avatar" class="avatar" onerror="this.src='/img/mypage.png';">
          <div>
            <div style="font-size:18px;font-weight:600;">${esc(u.username)} さんのマイページ（管理者閲覧）</div>
            <div class="muted">ID: ${esc(u.id)} / ロール: ${u.role === ROLE_SITE_ADMIN ? "サイト管理者" : (u.role === ROLE_ADMIN ? "管理者" : "一般")}</div>
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
        <h3>このユーザーの投稿一覧</h3>
        ${listHtml}
      </div>
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
        if (diff <= 0){ el.textContent = "まもなく再配布されます。"; return; }
        const d = Math.floor(diff / 86400); diff -= d*86400;
        const h = Math.floor(diff / 3600); diff -= h*3600;
        const m = Math.floor(diff / 60);
        const s = diff - m*60;
        el.textContent = "残り: " + (d? d+"日 " : "") + String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
        requestAnimationFrame(tick);
      }
      tick();
    })();

    // ----- アイコン更新（dataURL / URL） -----
    (function(){
      const file = document.getElementById("iconFile");
      const urlText = document.getElementById("iconUrlText");
      const hidden = document.getElementById("iconUrlHidden");
      const prev = document.getElementById("avatarPreview");
      const clearBtn = document.getElementById("clearIconBtn");
      const form = document.getElementById("iconForm");
      if (!hidden || !prev) return;

      function applyValue(v){
        hidden.value = v || "";
        if (v) prev.src = v;
      }

      if (file) {
        file.addEventListener("change", () => {
          const f = file.files && file.files[0];
          if (!f) return;
          if (!String(f.type || "").startsWith("image/")) {
            alert("画像ファイルを選択してください。");
            file.value = "";
            return;
          }
          // 目安: 350KB程度（保存サイズ制限があるため）
          if (f.size > 350 * 1024) {
            alert("画像が大きすぎます。350KB以下を目安にしてください。");
            file.value = "";
            return;
          }
          const rd = new FileReader();
          rd.onload = () => {
            const v = String(rd.result || "");
            applyValue(v);
            if (urlText) urlText.value = "";
          };
          rd.readAsDataURL(f);
        });
      }

      if (urlText) {
        urlText.addEventListener("input", () => {
          const v = (urlText.value || "").trim();
          if (v) applyValue(v);
          else applyValue("");
        });
      }

      if (form) {
        form.addEventListener("submit", () => {
          // URL入力がある場合は hidden を上書き
          const v = (urlText && urlText.value ? urlText.value : "").trim();
          if (v) hidden.value = v;
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener("click", async () => {
          if (!confirm("アイコンをリセットしますか？")) return;
          try {
            await fetch("/mypage/icon/clear", { method: "POST" });
            location.reload();
          } catch {
            alert("リセットに失敗しました。");
          }
        });
      }
    })();

    </script>
  </body>
  </html>`;

  res.send(html);
});


// ---- 個別ユーザー更新 ----
app.post("/admin/update-user", requireAdmin, async (req, res) => {
  await usersDb.read();
  const { id, tokens, role } = req.body || {};
  const u = usersDb.data.users.find(x => x.id === id);
  if (!u) return res.status(404).send("Not found");
  const operator = getUserById(req.cookies?.deviceId);
  // サイト管理者はサイト内の操作で変更できない（削除のみ例外）
  if (u.role === ROLE_SITE_ADMIN) {
    return res.send(toastPage("⚠サイト管理者の情報は変更できません。", "/admin/users"));
  }
  // サイト管理者ロールは管理画面から付与できない（1103でログインして取得）
  if (role === ROLE_SITE_ADMIN) {
    return res.send(toastPage("⚠サイト管理者ロールは管理画面から付与できません。", "/admin/users"));
  }
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
  // site_admin が混ざっていても除外して他だけ削除する
  for (const su of usersDb.data.users) {
    if (su.role === ROLE_SITE_ADMIN) idSet.delete(su.id);
  }
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
  const operator = getUserById(req.cookies?.deviceId);
  const target = usersDb.data.users.find(u => u.id === id);
  if (target && target.role === ROLE_SITE_ADMIN && !isSiteAdmin(operator)) {
    return res.send(toastPage("⚠サイト管理者アカウントはサイト管理者のみ削除できます。", "/admin/users"));
  }
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
    .avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:#e5e7eb;border:1px solid var(--border);}
    @media(max-width:560px){
      .kv{grid-template-columns:1fr}
      .list{grid-template-columns:1fr}
    }
  </style>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="row">
          <img src="${esc(u.iconUrl || "/img/mypage.png")}" alt="avatar" class="avatar" onerror="this.src='/img/mypage.png';">
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
        <h3>アイコン</h3>
        <p class="muted">画像ファイル（dataURL）または画像URLを保存できます。</p>

        <div class="row" style="align-items:flex-start;">
          <img id="avatarPreview" class="avatar" src="${esc(u.iconUrl || "/img/mypage.png")}" alt="avatar" onerror="this.src='/img/mypage.png';">
          <div style="flex:1;min-width:0;">
            <div class="muted" style="font-size:13px;margin-bottom:8px;">おすすめ: 300KB程度以下 / 正方形</div>
            <form id="iconForm" class="settings-form" method="POST" action="/mypage/icon" style="gap:10px;">
              <label style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <span class="muted">画像:</span>
                <input id="iconFile" type="file" accept="image/*" style="max-width:240px;">
              </label>

              <label style="display:flex;gap:8px;align-items:center;flex:1;min-width:220px;flex-wrap:wrap;">
                <span class="muted">URL:</span>
                <input id="iconUrlText" type="text" placeholder="https://example.com/icon.png" style="flex:1;min-width:180px;">
              </label>

              <input type="hidden" name="iconUrl" id="iconUrlHidden" value="">
              <button type="submit">保存する</button>
              <button type="button" id="clearIconBtn" class="btn">リセット</button>
            </form>
            <div class="muted" style="font-size:12px;margin-top:6px;">
              ※メッセージ取り消し等のサポート機能は後で実装します（今回はアイコンのみ）。
            </div>
          </div>
        </div>
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

    // ----- アイコン更新（dataURL / URL） -----
    (function(){
      const file = document.getElementById("iconFile");
      const urlText = document.getElementById("iconUrlText");
      const hidden = document.getElementById("iconUrlHidden");
      const prev = document.getElementById("avatarPreview");
      const clearBtn = document.getElementById("clearIconBtn");
      const form = document.getElementById("iconForm");
      if (!hidden || !prev) return;

      function applyValue(v){
        hidden.value = v || "";
        if (v) prev.src = v;
      }

      if (file) {
        file.addEventListener("change", () => {
          const f = file.files && file.files[0];
          if (!f) return;
          if (!String(f.type || "").startsWith("image/")) {
            alert("画像ファイルを選択してください。");
            file.value = "";
            return;
          }
          // 目安: 350KB程度（保存サイズ制限があるため）
          if (f.size > 350 * 1024) {
            alert("画像が大きすぎます。350KB以下を目安にしてください。");
            file.value = "";
            return;
          }
          const rd = new FileReader();
          rd.onload = () => {
            const v = String(rd.result || "");
            applyValue(v);
            if (urlText) urlText.value = "";
          };
          rd.readAsDataURL(f);
        });
      }

      if (urlText) {
        urlText.addEventListener("input", () => {
          const v = (urlText.value || "").trim();
          if (v) applyValue(v);
          else applyValue("");
        });
      }

      if (form) {
        form.addEventListener("submit", () => {
          // URL入力がある場合は hidden を上書き
          const v = (urlText && urlText.value ? urlText.value : "").trim();
          if (v) hidden.value = v;
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener("click", async () => {
          if (!confirm("アイコンをリセットしますか？")) return;
          try {
            await fetch("/mypage/icon/clear", { method: "POST" });
            location.reload();
          } catch {
            alert("リセットに失敗しました。");
          }
        });
      }
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
  const name = (req.body.username ?? "").toString().trim();
  if (!name) return res.send(toastPage("⚠ユーザー名を入力してください。", "/mypage"));
  if (name.length > 40) return res.send(toastPage("⚠ユーザー名が長すぎます。（最大40文字）", "/mypage"));
  if (/[\r\n]/.test(name)) return res.send(toastPage("⚠ユーザー名に使えない文字が含まれています。", "/mypage"));
  u.username = name;
  await usersDb.write();
return res.send(toastPage(`✅ユーザー名を「${name}」に更新しました。`, "/mypage"));
});


// ---- MyPage icon update ----

function validateIconUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return { ok: false, message: "アイコンが空です。" };

  // dataURL (data:image/...;base64,xxx)
  if (v.startsWith("data:image/")) {
    if (!v.includes(";base64,")) return { ok: false, message: "dataURL形式が不正です。" };
    // length-based guard (roughly ~ bytes * 1.37)
    if (v.length > 480000) return { ok: false, message: "画像が大きすぎます。350KB程度以下を目安にしてください。" };
    return { ok: true, value: v };
  }

  // URL
  if (/^https?:\/\//i.test(v)) {
    if (v.length > 2048) return { ok: false, message: "URLが長すぎます。" };
    return { ok: true, value: v };
  }

  return { ok: false, message: "http(s) のURL か data:image のみ保存できます。" };
}


app.post("/mypage/icon", async (req, res) => {
  if (!req.user) return res.send(toastPage("⚠未ログインです。", "/"));
  await usersDb.read();
  const u = usersDb.data.users.find(x => x.id === req.user.id);
  if (!u) return res.send(toastPage("⚠ユーザーが見つかりませんでした。", "/mypage"));

  const iconUrl = (req.body.iconUrl ?? "").toString();
  const v = validateIconUrl(iconUrl);
  if (!v.ok) return res.send(toastPage(`⚠${esc(v.message)}`, "/mypage"));

  u.iconUrl = v.value;
  await usersDb.write();
  return res.send(toastPage("✅アイコンを更新しました。", "/mypage"));
});

app.post("/mypage/icon/clear", async (req, res) => {
  if (!req.user) return res.status(401).send("not logged in");
  await usersDb.read();
  const u = usersDb.data.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).send("not found");
  u.iconUrl = null;
  await usersDb.write();
  res.send("ok");
});



// ==========================
// Support (チャット問い合わせ)
// ==========================
const SUPPORT_DESK_NAME = "サポート窓口";
const SUPPORT_DESK_ICON = "/img/mypage.png";

function supportStore() {
  if (!db.data.support) {
    db.data.support = {
      termsText: "",
      termsVersion: 1,
      threads: {}, // { [userId]: { userId, createdAtISO, updatedAtISO, lastPreview, messages:[...] } }
    };
  }
  if (typeof db.data.support.termsVersion !== "number") db.data.support.termsVersion = 1;
  if (typeof db.data.support.termsText !== "string") db.data.support.termsText = "";
  if (!db.data.support.threads || typeof db.data.support.threads !== "object") db.data.support.threads = {};
  return db.data.support;
}

/**
 * getSupportThread(userId, createIfMissing=true)
 * - createIfMissing=false のときは存在しない場合 null を返す（閲覧だけで thread を復活させないため）
 */
function getSupportThread(userId, createIfMissing = true) {
  const s = supportStore();
  let t = s.threads[userId];
  if (!t && createIfMissing) {
    const now = new Date().toISOString();
    t = s.threads[userId] = {
      userId,
      createdAtISO: now,
      updatedAtISO: now,
      lastPreview: "",
      messages: [],
    };
  }
  if (t && !Array.isArray(t.messages)) t.messages = [];
  return t || null;
}

function updateThreadMeta(t) {
  if (!t) return;
  const last = t.messages.length ? t.messages[t.messages.length - 1] : null;
  t.updatedAtISO = last?.atISO || t.updatedAtISO || new Date().toISOString();
  t.lastPreview = last?.text ? String(last.text).slice(0, 80) : (t.lastPreview || "");
}

function viewerAcceptedSupportTerms(viewer) {
  const s = supportStore();
  const v = Number(viewer?.supportTermsAcceptedVersion || 0);
  return v >= Number(s.termsVersion || 1);
}

function staffIdentity(reqUser) {
  // site_admin は自分のアカウントで返信できる
  if (isSiteAdmin(reqUser)) {
    return {
      kind: "staff",
      userId: reqUser.id,
      username: reqUser.username || "Site Admin",
      role: ROLE_SITE_ADMIN,
      iconUrl: reqUser.iconUrl || SUPPORT_DESK_ICON,
      badge: "💎サイト管理者",
    };
  }
  // admin は窓口アカウントとして返信（全管理者で共通）
  return {
    kind: "staff",
    userId: null,
    username: SUPPORT_DESK_NAME,
    role: "desk",
    iconUrl: SUPPORT_DESK_ICON,
    badge: null,
  };
}

function normalizeMsgForClient(m) {
  return {
    id: m?.id,
    atISO: m?.atISO,
    text: m?.text,
    from: m?.from ? {
      kind: m.from.kind || null,
      userId: m.from.userId || null,
      username: m.from.username || null,
      role: m.from.role || null,
      iconUrl: m.from.iconUrl || null,
      badge: m.from.badge || null,
    } : null,
  };
}
function buildUsersMap() {
  const m = new Map();
  try {
    for (const u of (usersDb.data?.users || [])) {
      if (u && u.id) m.set(u.id, u);
    }
  } catch {}
  return m;
}

function hydrateSupportMessage(m, usersMap) {
  if (!m || !m.from) return m;
  const out = { ...m, from: { ...(m.from || {}) } };

  // ユーザー投稿：常に最新の username / iconUrl / role / badge を反映
  if (out.from.kind === "user" && out.from.userId) {
    const u = usersMap.get(out.from.userId);
    if (u) {
      out.from.username = u.username || out.from.username || "Guest";
      out.from.iconUrl = u.iconUrl || out.from.iconUrl || null;
      out.from.role = u.role || out.from.role || ROLE_USER;
      out.from.badge = isSiteAdmin(u) ? "💎サイト管理者" : null;
    }
    return out;
  }

  // site_admin が「自分のアカウントで返信」した場合も最新を反映
  if (out.from.kind === "staff" && out.from.role === ROLE_SITE_ADMIN && out.from.userId) {
    const u = usersMap.get(out.from.userId);
    if (u) {
      out.from.username = u.username || out.from.username || "Site Admin";
      out.from.iconUrl = u.iconUrl || out.from.iconUrl || SUPPORT_DESK_ICON;
      out.from.badge = "💎サイト管理者";
    }
    return out;
  }

  // desk（共通窓口）
  if (out.from.kind === "staff" && !out.from.userId) {
    out.from.username = SUPPORT_DESK_NAME;
    out.from.iconUrl = SUPPORT_DESK_ICON;
    out.from.badge = null;
    out.from.role = "desk";
  }

  return out;
}

function hydrateSupportMessages(messages, usersMap) {
  const arr = Array.isArray(messages) ? messages : [];
  return arr.map(m => hydrateSupportMessage(m, usersMap));
}

function supportMsgHtmlSSR(m, isViewer) {
  const av = esc(m?.from?.iconUrl || SUPPORT_DESK_ICON);
  const uname = esc(m?.from?.username || "unknown");
  const badge = m?.from?.badge ? ` <span class="badge">${esc(m.from.badge)}</span>` : "";
  const txt = esc(m?.text || "").replace(/\n/g, "<br>");
  const t = esc(m?.atISO ? fmtJst(m.atISO) : "");
  const uid = (m?.from?.userId != null) ? ` <code>🆔 ${esc(m.from.userId)}</code>` : ` <code>🆔 -</code>`;
  const mid = esc(m?.id || "");
  // data-text はコピー用（属性なので改行は保持せず）
  const dataText = esc((m?.text || "").toString());
  return `
    <div class="msg ${isViewer ? "viewer" : "other"}" data-mid="${mid}">
      <img class="avatar" src="${av}" onerror="this.src='${SUPPORT_DESK_ICON}'">
      <div class="bubble" tabindex="0" data-text="${dataText}">
        <div class="name">${uname}${badge}</div>
        <div class="body">${txt}</div>
        <div class="time"><span>${t}</span>${uid}</div>
      </div>
    </div>
  `;
}

async function appendSupportMessageAsUser(u, text) {
  await db.read();
  const t = getSupportThread(u.id, true);
  const msg = {
    id: nanoid(10),
    atISO: new Date().toISOString(),
    text,
    from: {
      kind: "user",
      userId: u.id,
      username: u.username || "Guest",
      role: u.role || ROLE_USER,
      iconUrl: u.iconUrl || null,
      badge: isSiteAdmin(u) ? "💎サイト管理者" : null,
    },
  };
  t.messages.push(msg);
  updateThreadMeta(t);
  await db.write();
  return msg;
}

async function appendSupportMessageAsStaff(targetUserId, reqUser, text) {
  await db.read();
  const t = getSupportThread(targetUserId, true);
  const from = staffIdentity(reqUser || null);
  const msg = { id: nanoid(10), atISO: new Date().toISOString(), text, from };
  t.messages.push(msg);
  updateThreadMeta(t);
  await db.write();
  return msg;
}

async function deleteSupportThread(userId) {
  await db.read();
  const s = supportStore();
  if (s.threads && s.threads[userId]) {
    delete s.threads[userId];
    await db.write();
    return true;
  }
  return false;
}

// ==========================
// /support (ユーザー側)
// ==========================
app.get("/support", async (req, res) => {
  if (!req.user) return res.send(toastPage("⚠サポートを開くには、まず登録してください。", "/"));
  await usersDb.read();
  const u = usersDb.data.users.find(x => x.id === req.user.id);
  if (!u) return res.send(toastPage("⚠ユーザーが見つかりませんでした。", "/"));

  await db.read();
  const s = supportStore();
  const needsTerms = !viewerAcceptedSupportTerms(u);

  // SSR: ここで既存メッセージを描画（JS が落ちても見える / 送信後リロードでも見える）
  let initialMsgsHtml = "";
  if (!needsTerms) {
    await db.read();
    const t = getSupportThread(u.id, false);
    const usersMap = buildUsersMap();
    const msgs = hydrateSupportMessages(t?.messages || [], usersMap);
    initialMsgsHtml = msgs.map(m => supportMsgHtmlSSR(m, (m?.from?.kind === "user" && m?.from?.userId === u.id))).join("");
  }

  const termsTextEsc = esc(s.termsText || "");

  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>サポート</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,"Noto Sans JP",sans-serif;background:#ffffff;color:#111827;}
    a{color:#2563eb;text-decoration:none}
    .top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;background:#ffffff;border-bottom:1px solid rgba(0,0,0,.08);position:sticky;top:0;z-index:10;}
    .top .left{display:flex;align-items:center;gap:10px;min-width:0;}
    .pill{display:inline-flex;align-items:center;gap:8px;background:#f3f4f6;border:1px solid rgba(0,0,0,.10);border-radius:999px;padding:6px 10px;color:#111827;font-size:13px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pill img{width:24px;height:24px;border-radius:999px;object-fit:cover;background:#e5e7eb;}
    .meta{opacity:.75;font-size:12px}
    .wrap{max-width:980px;margin:0 auto;padding:0 10px;}
    .chat{display:flex;flex-direction:column;height:calc(100vh - 56px);height:calc(100dvh - 56px);background:#ffffff;min-height:0;}
    .msgs{flex:1;min-height:0;overflow:auto;padding:14px 6px 10px;background:#ffffff;}
    .msg{display:flex;gap:10px;margin:10px 0;align-items:flex-end;}
    .msg.viewer{justify-content:flex-start;}
    .msg.other{justify-content:flex-end;flex-direction:row-reverse;}
    .avatar{width:36px;height:36px;border-radius:999px;object-fit:cover;background:#e5e7eb;border:1px solid rgba(0,0,0,.10);}
    .bubble{max-width:min(680px,86vw);background:#f3f4f6;border:1px solid rgba(0,0,0,.10);border-radius:14px;padding:10px 12px;line-height:1.45;user-select:text;}
    .other .bubble{background:#e0f2fe;border-color:rgba(2,132,199,.25);}
    .name{font-size:12px;opacity:.85;margin:0 0 4px;display:flex;gap:8px;align-items:center;}
    .badge{font-size:12px;color:#0284c7;}
    .time{font-size:11px;opacity:.65;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;}
    .time code{padding:1px 6px;border-radius:999px;border:1px solid rgba(0,0,0,.10);background:rgba(255,255,255,.85);}
    .input{border-top:1px solid rgba(0,0,0,.08);padding:10px;background:#ffffff;padding-bottom:calc(10px + env(safe-area-inset-bottom));}
    .row{display:flex;gap:10px;align-items:flex-end;}
    @media (max-width:520px){.row{flex-direction:column;align-items:stretch}textarea{max-height:34vh}button{width:100%}}
    textarea{flex:1;min-height:44px;max-height:180px;resize:vertical;background:#ffffff;color:#111827;border:1px solid rgba(0,0,0,.18);border-radius:12px;padding:10px 12px;font-size:14px;outline:none}
    button{background:#2563eb;color:#fff;border:none;border-radius:12px;padding:10px 14px;cursor:pointer;font-weight:600}
    button:disabled{opacity:.5;cursor:not-allowed}
    .hint{margin-top:6px;font-size:12px;opacity:.7}
    /* context menu */
    .ctx{position:fixed;z-index:9999;min-width:180px;background:#ffffff;border:1px solid rgba(0,0,0,.16);border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.18);display:none;overflow:hidden}
    .ctx button{width:100%;text-align:left;background:transparent;border:none;color:#111827;padding:10px 12px;border-radius:0;font-weight:700}
    .ctx button:hover{background:rgba(0,0,0,.05)}
    /* terms overlay */
    .ov{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:10000;padding:14px;}
    .ov.show{display:flex;}
    .modal{width:min(720px,92vw);background:#f9fafb;color:#111;border-radius:14px;border:1px solid rgba(0,0,0,.08);box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden}
    .modal .hd{padding:14px 16px;text-align:center;font-weight:800;color:#6b7280;border-bottom:1px solid rgba(0,0,0,.06)}
    .modal .bd{padding:16px;}
    .modal .bd .box{background:#fff;border:1px solid rgba(0,0,0,.10);border-radius:12px;padding:14px;text-align:center;}
    .modal .bd p{margin:0 0 10px;opacity:.85}
    .terms-open-wrap{margin-top:10px;display:flex;justify-content:center;}
.terms-open{list-style:none;display:inline-flex;justify-content:center;align-items:center;background:#fff;border:1px solid rgba(59,130,246,.55);color:#1d4ed8;border-radius:999px;padding:10px 18px;font-weight:800;cursor:pointer;user-select:none;}
.terms-view{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:10001;padding:14px;}
.terms-view.show{display:flex;}
.terms-card{width:min(860px,94vw);max-height:min(84vh,84dvh);background:#fff;color:#111;border-radius:16px;border:1px solid rgba(0,0,0,.10);box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden;display:flex;flex-direction:column;}
.terms-card .thd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;background:#f9fafb;border-bottom:1px solid rgba(0,0,0,.08);}
.terms-card .ttl{font-weight:900;}
.terms-card .x{width:36px;height:36px;border-radius:10px;border:1px solid rgba(0,0,0,.14);background:#fff;cursor:pointer;font-size:20px;line-height:1;display:inline-flex;align-items:center;justify-content:center;color:#111;}
.terms-card .x:hover{background:rgba(0,0,0,.04)}
.terms-card .tbody{padding:14px;overflow:auto;white-space:pre-wrap;font-size:13px;line-height:1.6;}
.terms-card .tft{display:flex;gap:10px;justify-content:flex-end;align-items:center;padding:12px 14px;background:#f9fafb;border-top:1px solid rgba(0,0,0,.08);flex-wrap:wrap;}
.terms-card .tft button{border-radius:999px;min-width:140px;}
.terms-card .tft .tclose{background:#fff;color:#111;border:1px solid rgba(0,0,0,.18);}
.terms-card .tft .tagree{background:#2563eb;color:#fff;border:none;}
.modal .ft{display:flex;gap:12px;justify-content:center;padding:14px 16px;border-top:1px solid rgba(0,0,0,.06)}
    .modal .ft button,.modal .ft a{min-width:160px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;}
    .modal .ft .no{background:#fff;color:#111;border:1px solid rgba(0,0,0,.18)}
  </style>
  <body>
    <div class="top">
      <div class="left">
        <a class="pill" href="/">← 戻る</a>
        <div class="pill" title="${esc(u.username)}">
          <img src="${esc(u.iconUrl || SUPPORT_DESK_ICON)}" onerror="this.src='${SUPPORT_DESK_ICON}'">
          <span>サポート</span>
          <span class="meta">🆔 ${esc(u.id)}</span>
        </div>
      </div>
      <div class="meta">閲覧者＝左 / 相手＝右</div>
    </div>

    <div class="wrap chat">
      <div id="msgs" class="msgs">${initialMsgsHtml}</div>

      <div class="input">
        <form id="sendForm" class="row" method="POST" action="/support/send">
          <textarea id="text" name="text" placeholder="メッセージを入力…（取り消し不可）" ${needsTerms ? "disabled" : ""}></textarea>
          <button id="sendBtn" type="submit" ${needsTerms ? "disabled" : ""}>送信</button>
        </form>
        <div class="hint">※ 内容は記録されます。個人情報の送信はお控えください。右クリックでショートカット（コピー）が出ます。</div>
      </div>
    </div>

    <div id="ctx" class="ctx" role="menu" aria-hidden="true">
      <button data-act="copy">テキストをコピー</button>
    </div>

    <div id="ov" class="ov ${needsTerms ? "show" : ""}">
      <div class="modal">
        <div class="hd">利用規約の同意</div>
        <div class="bd">
          <div class="box">
            <p>サービスを利用するには利用規約の同意が必要です。<br>利用規約をご確認ください。</p>
            <div class="terms-open-wrap">
              <button type="button" id="openTermsBtn" class="terms-open">利用規約を確認</button>
            </div>
</div>
        </div>
        <div class="ft">
          <a class="no" href="/">同意しない</a>
          <form method="POST" action="/support/terms/accept">
            <button type="submit">同意する</button>
          </form>
        </div>
      </div>
    </div>


    <div id="termsView" class="terms-view" aria-hidden="true">
      <div class="terms-card" role="dialog" aria-modal="true" aria-labelledby="termsTtl">
        <div class="thd">
          <div class="ttl" id="termsTtl">利用規約</div>
          <button type="button" class="x" data-close-terms aria-label="閉じる">×</button>
        </div>
        <div class="tbody">${termsTextEsc}</div>
        <div class="tft">
          <button type="button" class="tclose" data-close-terms>閉じる</button>
          <form method="POST" action="/support/terms/accept">
            <button type="submit" class="tagree">同意する</button>
          </form>
        </div>
      </div>
    </div>

    <script>
      window.addEventListener('DOMContentLoaded', function(){
        var NEEDS_TERMS = ${needsTerms ? "true" : "false"};

        function escHtml(s){ return String(s??'').replace(/[&<>"']/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }
        function byId(id){ return document.getElementById(id); }

        // Terms viewer (better UI than <details>)
        var termsView = byId('termsView');
        var openTermsBtn = byId('openTermsBtn');
        function openTerms(){
          if (!termsView) return;
          termsView.classList.add('show');
          termsView.setAttribute('aria-hidden','false');
        }
        function closeTerms(){
          if (!termsView) return;
          termsView.classList.remove('show');
          termsView.setAttribute('aria-hidden','true');
        }
        if (openTermsBtn) openTermsBtn.addEventListener('click', function(ev){ ev.preventDefault(); openTerms(); });
        if (termsView) {
          termsView.addEventListener('click', function(ev){ if (ev.target === termsView) closeTerms(); });
        }
        document.querySelectorAll('[data-close-terms]').forEach(function(el){
          el.addEventListener('click', function(ev){ ev.preventDefault(); closeTerms(); });
        });
        window.addEventListener('keydown', function(ev){ if (ev.key === 'Escape') closeTerms(); });


        async function api(path, body){
          var opt = body ? { method:'POST', headers:{ 'Content-Type':'application/json', 'Accept':'application/json' }, body: JSON.stringify(body), credentials:'include' } : { headers:{ 'Accept':'application/json' }, credentials:'include' };
          var r = await fetch(path, opt);
          var j = null;
          try{ j = await r.json(); }catch(e){}
          return { ok:r.ok, status:r.status, json:j };
        }

        function render(messages, viewerId){
          var root = byId('msgs');
          root.innerHTML = '';
          for (var i=0;i<messages.length;i++){
            var m = messages[i];
            var isViewer = (m && m.from && m.from.kind === 'user' && m.from.userId === viewerId);
            var wrap = document.createElement('div');
            wrap.className = 'msg ' + (isViewer ? 'viewer' : 'other');
            wrap.dataset.mid = m.id || '';

            var av = document.createElement('img');
            av.className = 'avatar';
            av.src = (m.from && m.from.iconUrl) ? m.from.iconUrl : '${SUPPORT_DESK_ICON}';
            av.onerror = function(){ this.src = '${SUPPORT_DESK_ICON}'; };

            var bub = document.createElement('div');
            bub.className = 'bubble';
            bub.tabIndex = 0;
            bub.dataset.text = m.text || '';

            var name = document.createElement('div');
            name.className = 'name';
            name.innerHTML = escHtml((m.from && m.from.username) ? m.from.username : 'unknown') + ((m.from && m.from.badge) ? (' <span class="badge">' + escHtml(m.from.badge) + '</span>') : '');

            var body = document.createElement('div');
            body.className = 'body';
            body.innerHTML = escHtml(m.text || '').replace(/\\n/g,'<br>');

            var time = document.createElement('div');
            time.className = 'time';
            var d = m.atISO ? new Date(m.atISO).toLocaleString('ja-JP') : '';
            var uid = (m.from && m.from.userId != null) ? (' <code>🆔 ' + escHtml(m.from.userId) + '</code>') : ' <code>🆔 -</code>';
            time.innerHTML = '<span>' + escHtml(d) + '</span>' + uid;

            bub.appendChild(name);
            bub.appendChild(body);
            bub.appendChild(time);

            wrap.appendChild(av);
            wrap.appendChild(bub);
            root.appendChild(wrap);
          }
          root.scrollTop = root.scrollHeight + 999;
        }

        async function load(){
          var r = await api('/support/api/thread');
          if (!r.ok){
            if (r.status === 403 && r.json && r.json.reason === 'terms_required') return;
            console.warn('thread load failed', r.status, r.json);
            return;
          }
          render((r.json && r.json.messages) ? r.json.messages : [], (r.json && r.json.viewer) ? r.json.viewer.id : null);
        }

        async function sendViaApi(text){
          var r = await api('/support/api/send', { text:text });
          return r;
        }

        // context menu (copy)
        var ctx = byId('ctx');
        var ctxTargetText = '';
        function hideCtx(){ ctx.style.display='none'; ctxTargetText=''; }
        document.addEventListener('click', hideCtx);
        document.addEventListener('keydown', function(e){ if(e.key==='Escape') hideCtx(); });

        byId('msgs').addEventListener('contextmenu', function(e){
          var bub = e.target.closest('.bubble');
          if (!bub) return;
          e.preventDefault();
          ctxTargetText = bub.dataset.text || '';
          ctx.style.left = Math.min(window.innerWidth-200, e.clientX) + 'px';
          ctx.style.top  = Math.min(window.innerHeight-120, e.clientY) + 'px';
          ctx.style.display = 'block';
        });

        ctx.addEventListener('click', async function(e){
          var act = e.target && e.target.dataset ? e.target.dataset.act : '';
          if (act === 'copy'){
            try{ await navigator.clipboard.writeText(ctxTargetText || ''); }catch(err){}
            hideCtx();
          }
        });

        // send (フォームはフォールバック。JS が動けばリロードなし)
        var sendForm = byId('sendForm');
        if (sendForm){
          sendForm.addEventListener('submit', async function(e){
            if (NEEDS_TERMS) return; // disabled anyway
            e.preventDefault();
            var ta = byId('text');
            var v = (ta.value||'').trim();
            if (!v) return;
            byId('sendBtn').disabled = true;
            try{
              var r = await sendViaApi(v);
              byId('sendBtn').disabled = false;
              if (!r.ok){
                // 失敗時はフォーム送信でフォールバック（原因調査用）
                console.warn('send failed', r.status, r.json);
                sendForm.submit();
                return;
              }
              ta.value = '';
              await load();
            }catch(err){
              byId('sendBtn').disabled = false;
              sendForm.submit();
            }
          });
        }

        byId('text').addEventListener('keydown', function(e){
          if(e.key==='Enter' && (e.ctrlKey || e.metaKey)){
            e.preventDefault();
            byId('sendBtn').click();
          }
        });

        if (!NEEDS_TERMS){
          // 初回ロード（SSRありでも最新化のため）
          load();
        }
      });
    </script>
  </body></html>`;

  res.send(html);
});

app.post("/support/terms/accept", async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, reason: "not_logged_in" });
  await usersDb.read();
  const u = usersDb.data.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ ok: false, reason: "not_found" });
  await db.read();
  const s = supportStore();
  u.supportTermsAcceptedVersion = Number(s.termsVersion || 1);
  await usersDb.write();

  const accept = (req.get("accept") || "").toLowerCase();
  if (accept.includes("text/html")) return res.redirect("/support");
  return res.json({ ok: true });
});

app.get("/support/api/thread", async (req, res) => {
  if (!req.user) return res.status(401).json({ ok:false, reason:"not_logged_in" });
  await usersDb.read();
  const u = usersDb.data.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ ok:false, reason:"not_found" });

  await db.read();
  if (!viewerAcceptedSupportTerms(u)) {
    return res.status(403).json({ ok:false, reason:"terms_required" });
  }

  const t = getSupportThread(u.id, false);
  const viewer = { id: u.id, username: u.username, role: u.role, iconUrl: u.iconUrl || null };

  return res.json({
    ok: true,
    viewer,
    messages: hydrateSupportMessages((t?.messages || []), buildUsersMap()).map(normalizeMsgForClient),
  });
});

app.post("/support/api/send", async (req, res) => {
  if (!req.user) return res.status(401).json({ ok:false, reason:"not_logged_in" });
  await usersDb.read();
  const u = usersDb.data.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ ok:false, reason:"not_found" });
  await db.read();
  if (!viewerAcceptedSupportTerms(u)) return res.status(403).json({ ok:false, reason:"terms_required" });

  const text = (req.body?.text ?? "").toString().trim();
  if (!text) return res.status(400).json({ ok:false, message:"空のメッセージは送信できません。" });
  if (text.length > 2000) return res.status(400).json({ ok:false, message:"メッセージが長すぎます（2000文字まで）。" });

  const msg = await appendSupportMessageAsUser(u, text);
  return res.json({ ok:true, message: normalizeMsgForClient(msg) });
});

// フォーム送信用（JS が死んでも送れる）
app.post("/support/send", async (req, res) => {
  if (!req.user) return res.send(toastPage("⚠未ログインです。", "/"));
  await usersDb.read();
  const u = usersDb.data.users.find(x => x.id === req.user.id);
  if (!u) return res.send(toastPage("⚠ユーザーが見つかりませんでした。", "/"));
  await db.read();
  if (!viewerAcceptedSupportTerms(u)) return res.send(toastPage("⚠利用規約への同意が必要です。", "/support"));

  const text = (req.body?.text ?? req.body?.message ?? "").toString().trim();
  if (!text) return res.redirect("/support");
  if (text.length > 2000) return res.send(toastPage("⚠メッセージが長すぎます（2000文字まで）。", "/support"));

  await appendSupportMessageAsUser(u, text);
  return res.redirect("/support");
});

// ==========================
// 管理者：問い合わせ一覧 / 返信
// ==========================
app.get("/admin/supports", requireAdmin, async (req, res) => {
  await db.read();
  await usersDb.read();
  const s = supportStore();

  const threads = Object.values(s.threads || {}).sort((a,b)=>{
    const ta = new Date(a.updatedAtISO || a.createdAtISO || 0).getTime();
    const tb = new Date(b.updatedAtISO || b.createdAtISO || 0).getTime();
    return tb - ta;
  });

  const rows = threads.map(t=>{
    const user = usersDb.data.users.find(x=>x.id===t.userId) || null;
    const uname = user?.username || t.userId;
    const icon = esc(user?.iconUrl || "/img/mypage.png");
    const when = esc(fmtJst(t.updatedAtISO || t.createdAtISO));
    const preview = esc(t.lastPreview || "");
    const uid = esc(t.userId);
    return `
      <div class="rowwrap">
        <a class="row" href="/admin/supports/${encodeURIComponent(t.userId)}">
          <img src="${icon}" onerror="this.src='/img/mypage.png'">
          <div class="col">
            <div class="topline"><span class="name">${uname}</span><span class="time">${when}</span></div>
            <div class="preview">${preview || "&nbsp;"}</div>
            <div class="sub">🆔 ${uid}</div>
          </div>
        </a>
        <form class="del" method="POST" action="/admin/supports/${encodeURIComponent(t.userId)}/delete-thread" onsubmit="return confirm('このスレッドを削除します。メッセージも全て消えます。よろしいですか？');">
          <button type="submit" title="スレッド削除">🗑</button>
        </form>
      </div>
    `;
  }).join("");

  const termsText = esc(s.termsText || "");
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>問い合わせ一覧</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,"Noto Sans JP",sans-serif;background:#ffffff;color:#111827;}
    a{color:#2563eb;text-decoration:none}
    .top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;background:#ffffff;border-bottom:1px solid rgba(0,0,0,.08);position:sticky;top:0;z-index:10;}
    .wrap{max-width:980px;margin:0 auto;padding:14px 10px 40px;}
    .btn{display:inline-flex;align-items:center;gap:8px;background:#f3f4f6;border:1px solid rgba(0,0,0,.10);border-radius:999px;padding:8px 12px;color:#111827;font-weight:700}
    .list{margin-top:14px;border:1px solid rgba(0,0,0,.10);border-radius:14px;overflow:hidden;background:#fff}
    .rowwrap{display:flex;align-items:stretch;border-top:1px solid rgba(0,0,0,.08);}
    .rowwrap:first-child{border-top:none}
    .row{flex:1;display:flex;gap:12px;padding:12px 12px;align-items:center;min-width:0}
    .row img{width:44px;height:44px;border-radius:999px;object-fit:cover;background:#e5e7eb;border:1px solid rgba(0,0,0,.10)}
    .col{min-width:0;flex:1}
    .topline{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
    .name{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .time{font-size:12px;opacity:.65;white-space:nowrap}
    .preview{margin-top:2px;font-size:13px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sub{margin-top:2px;font-size:12px;opacity:.65}
    .del{display:flex;align-items:center;padding:0 10px}
    .del button{border:none;background:#fff;border-left:1px solid rgba(0,0,0,.08);padding:0 12px;font-size:18px;cursor:pointer}
    .del button:hover{background:rgba(0,0,0,.04)}
    .card{margin-top:18px;background:#fff;border:1px solid rgba(0,0,0,.10);border-radius:14px;padding:12px}
    textarea{width:100%;min-height:160px;border:1px solid rgba(0,0,0,.18);border-radius:12px;padding:10px 12px;font-size:13px;outline:none}
    .actions{display:flex;justify-content:flex-end;margin-top:10px}
    .save{background:#2563eb;color:#fff;border:none;border-radius:12px;padding:10px 14px;font-weight:800;cursor:pointer}
    .meta{font-size:12px;opacity:.7;margin-top:6px}
    .empty{padding:20px;text-align:center;opacity:.7}
  </style>
  <body>
    <div class="top">
      <div style="display:flex;gap:10px;align-items:center">
        <a class="btn" href="/admin">← 管理画面</a>
        <div style="font-weight:900">問い合わせ一覧</div>
      </div>
      <div class="meta">threads: ${threads.length}</div>
    </div>

    <div class="wrap">
      <div class="list">
        ${rows || `<div class="empty">問い合わせはまだありません</div>`}
      </div>

      <div class="card">
        <div style="font-weight:900;margin-bottom:8px">サポート利用規約（ユーザーに表示）</div>
        <form method="POST" action="/admin/support-terms">
          <textarea name="termsText">${termsText}</textarea>
          <div class="actions"><button class="save" type="submit">保存（バージョン更新）</button></div>
          <div class="meta">保存すると termsVersion が +1 され、ユーザーは再同意が必要になります。</div>
        </form>
      </div>
    </div>
  </body></html>`;
  res.send(html);
});

app.post("/admin/support-terms", requireAdmin, async (req, res) => {
  const termsText = (req.body?.termsText ?? "").toString();
  await db.read();
  const s = supportStore();
  s.termsText = termsText;
  s.termsVersion = Number(s.termsVersion || 1) + 1;
  await db.write();
  return res.redirect("/admin/supports");
});

// thread delete (HTMLフォーム)
app.post("/admin/supports/:userId/delete-thread", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  await deleteSupportThread(userId);
  return res.redirect("/admin/supports");
});

// thread delete (API)
app.post("/admin/supports/:userId/api/delete-thread", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  const ok = await deleteSupportThread(userId);
  return res.json({ ok, userId });
});
// clear all messages in a thread (HTML)
app.post("/admin/supports/:userId/clear", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  await db.read();
  const t = getSupportThread(userId, true);
  t.messages = [];
  updateThreadMeta(t);
  await db.write();
  return res.redirect("/admin/supports/" + encodeURIComponent(userId));
});

// clear all messages in a thread (API)
app.post("/admin/supports/:userId/api/clear", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  await db.read();
  const t = getSupportThread(userId, true);
  const before = t.messages.length;
  t.messages = [];
  updateThreadMeta(t);
  await db.write();
  return res.json({ ok: true, cleared: before, userId });
});

app.get("/admin/supports/:userId", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  await usersDb.read();
  await db.read();

  const target = usersDb.data.users.find(x => x.id === userId) || null;
  const titleName = target?.username || userId;

  const t = getSupportThread(userId, false);
  const usersMap = buildUsersMap();
  const initialMsgsHtml = hydrateSupportMessages((t?.messages || []), usersMap).map(m => supportMsgHtmlSSR(m, (m?.from?.kind === "staff"))).join("");

  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>サポート返信 - ${esc(titleName)}</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,"Noto Sans JP",sans-serif;background:#ffffff;color:#111827;}
    a{color:#2563eb;text-decoration:none}
    .top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;background:#ffffff;border-bottom:1px solid rgba(0,0,0,.08);position:sticky;top:0;z-index:10;}
    .left{display:flex;align-items:center;gap:10px;min-width:0;}
    .pill{display:inline-flex;align-items:center;gap:8px;background:#f3f4f6;border:1px solid rgba(0,0,0,.10);border-radius:999px;padding:6px 10px;color:#111827;font-size:13px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pill img{width:24px;height:24px;border-radius:999px;object-fit:cover;background:#e5e7eb;}
    .meta{opacity:.75;font-size:12px}
    .wrap{max-width:980px;margin:0 auto;padding:0 10px;}
    .chat{display:flex;flex-direction:column;height:calc(100vh - 56px);height:calc(100dvh - 56px);background:#ffffff;min-height:0;}
    .msgs{flex:1;min-height:0;overflow:auto;padding:14px 6px 10px;background:#ffffff;}
    .msg{display:flex;gap:10px;margin:10px 0;align-items:flex-end;}
    .msg.viewer{justify-content:flex-start;}
    .msg.other{justify-content:flex-end;flex-direction:row-reverse;}
    .avatar{width:36px;height:36px;border-radius:999px;object-fit:cover;background:#e5e7eb;border:1px solid rgba(0,0,0,.10);}
    .bubble{max-width:min(680px,86vw);background:#f3f4f6;border:1px solid rgba(0,0,0,.10);border-radius:14px;padding:10px 12px;line-height:1.45;user-select:text;}
    .other .bubble{background:#e0f2fe;border-color:rgba(2,132,199,.25);}
    .name{font-size:12px;opacity:.85;margin:0 0 4px;display:flex;gap:8px;align-items:center;}
    .badge{font-size:12px;color:#0284c7;}
    .time{font-size:11px;opacity:.65;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;}
    .time code{padding:1px 6px;border-radius:999px;border:1px solid rgba(0,0,0,.10);background:rgba(255,255,255,.85);}
    .input{border-top:1px solid rgba(0,0,0,.08);padding:10px;background:#ffffff;padding-bottom:calc(10px + env(safe-area-inset-bottom));}
    .row{display:flex;gap:10px;align-items:flex-end;}
    @media (max-width:520px){.row{flex-direction:column;align-items:stretch}textarea{max-height:34vh}button{width:100%}}
    textarea{flex:1;min-height:44px;max-height:180px;resize:vertical;background:#ffffff;color:#111827;border:1px solid rgba(0,0,0,.18);border-radius:12px;padding:10px 12px;font-size:14px;outline:none}
    button{background:#2563eb;color:#fff;border:none;border-radius:12px;padding:10px 14px;cursor:pointer;font-weight:700}
    .btn2{background:#fff;color:#111827;border:1px solid rgba(0,0,0,.18)}
    button:disabled{opacity:.5;cursor:not-allowed}
    .hint{margin-top:6px;font-size:12px;opacity:.7}
    /* context menu */
    .ctx{position:fixed;z-index:9999;min-width:220px;background:#ffffff;border:1px solid rgba(0,0,0,.16);border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,.18);display:none;overflow:hidden}
    .ctx button{width:100%;text-align:left;background:transparent;border:none;color:#111827;padding:10px 12px;border-radius:0;font-weight:800}
    .ctx button:hover{background:rgba(0,0,0,.05)}
    .ctx hr{border:0;border-top:1px solid rgba(0,0,0,.08);margin:0}
  </style>
  <body>
    <div class="top">
      <div class="left">
        <a class="pill" href="/admin/supports">← 一覧</a>
        <div class="pill" title="${esc(titleName)}">
          <img src="${esc(target?.iconUrl || "/img/mypage.png")}" onerror="this.src='/img/mypage.png'">
          <span>${esc(titleName)}</span>
          <span class="meta">🆔 ${esc(userId)}</span>
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <div class="meta">閲覧者＝左 / 相手＝右</div>
        <form method="POST" action="/admin/supports/${encodeURIComponent(userId)}/clear" onsubmit="return confirm(\'このチャットのメッセージを全削除します。よろしいですか？\');">
          <button type="submit" class="btn2">🧹 メッセ全削除</button>
        </form>

        <form method="POST" action="/admin/supports/${encodeURIComponent(userId)}/delete-thread" onsubmit="return confirm('このスレッドを削除します。メッセージも全て消えます。よろしいですか？');">
          <button type="submit" class="btn2">🗑 スレッド削除</button>
        </form>
      </div>
    </div>

    <div class="wrap chat">
      <div id="msgs" class="msgs">${initialMsgsHtml}</div>

      <div class="input">
        <form id="sendForm" class="row" method="POST" action="/admin/supports/${encodeURIComponent(userId)}/send">
          <textarea id="text" name="text" placeholder="メッセージを入力…（取り消し不可）"></textarea>
          <button id="sendBtn" type="submit">送信</button>
        </form>
        <div class="hint">※ 右クリックでショートカット（コピー / メッセージ削除）が出ます。</div>
      </div>
    </div>

    <div id="ctx" class="ctx" role="menu" aria-hidden="true">
      <button data-act="copy">テキストをコピー</button>
      <hr>
      <button data-act="del">メッセージを削除</button>
    </div>

    <script>
      window.addEventListener('DOMContentLoaded', function(){
        var USER_ID = ${JSON.stringify(userId)};

        function escHtml(s){ return String(s??'').replace(/[&<>"']/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }
        function byId(id){ return document.getElementById(id); }

        async function api(path, body){
          var opt = body ? { method:'POST', headers:{ 'Content-Type':'application/json', 'Accept':'application/json' }, body: JSON.stringify(body), credentials:'include' } : { headers:{ 'Accept':'application/json' }, credentials:'include' };
          var r = await fetch(path, opt);
          var j = null;
          try{ j = await r.json(); }catch(e){}
          return { ok:r.ok, status:r.status, json:j };
        }

        function render(messages){
          var root = byId('msgs');
          root.innerHTML = '';
          for (var i=0;i<messages.length;i++){
            var m = messages[i];
            // 管理画面では staff が閲覧者（左）
            var isViewer = (m && m.from && m.from.kind === 'staff');
            var wrap = document.createElement('div');
            wrap.className = 'msg ' + (isViewer ? 'viewer' : 'other');
            wrap.dataset.mid = m.id || '';

            var av = document.createElement('img');
            av.className = 'avatar';
            av.src = (m.from && m.from.iconUrl) ? m.from.iconUrl : '${SUPPORT_DESK_ICON}';
            av.onerror = function(){ this.src = '${SUPPORT_DESK_ICON}'; };

            var bub = document.createElement('div');
            bub.className = 'bubble';
            bub.tabIndex = 0;
            bub.dataset.text = m.text || '';

            var name = document.createElement('div');
            name.className = 'name';
            name.innerHTML = escHtml((m.from && m.from.username) ? m.from.username : 'unknown') + ((m.from && m.from.badge) ? (' <span class="badge">' + escHtml(m.from.badge) + '</span>') : '');

            var body = document.createElement('div');
            body.className = 'body';
            body.innerHTML = escHtml(m.text || '').replace(/\\n/g,'<br>');

            var time = document.createElement('div');
            time.className = 'time';
            var d = m.atISO ? new Date(m.atISO).toLocaleString('ja-JP') : '';
            var uid = (m.from && m.from.userId != null) ? (' <code>🆔 ' + escHtml(m.from.userId) + '</code>') : ' <code>🆔 -</code>';
            time.innerHTML = '<span>' + escHtml(d) + '</span>' + uid;

            bub.appendChild(name);
            bub.appendChild(body);
            bub.appendChild(time);

            wrap.appendChild(av);
            wrap.appendChild(bub);
            root.appendChild(wrap);
          }
          root.scrollTop = root.scrollHeight + 999;
        }

        async function load(){
          var r = await api('/admin/supports/' + encodeURIComponent(USER_ID) + '/api/thread');
          if (!r.ok){ console.warn('thread load failed', r.status, r.json); return; }
          render((r.json && r.json.messages) ? r.json.messages : []);
        }

        // context menu
        var ctx = byId('ctx');
        var ctxTargetText = '';
        var ctxTargetId = '';
        function hideCtx(){ ctx.style.display='none'; ctxTargetText=''; ctxTargetId=''; }
        document.addEventListener('click', hideCtx);
        document.addEventListener('keydown', function(e){ if(e.key==='Escape') hideCtx(); });

        byId('msgs').addEventListener('contextmenu', function(e){
          var bub = e.target.closest('.bubble');
          if (!bub) return;
          e.preventDefault();
          var row = bub.closest('.msg');
          ctxTargetText = bub.dataset.text || '';
          ctxTargetId = row ? (row.dataset.mid || '') : '';
          ctx.style.left = Math.min(window.innerWidth-240, e.clientX) + 'px';
          ctx.style.top  = Math.min(window.innerHeight-160, e.clientY) + 'px';
          ctx.style.display = 'block';
        });

        ctx.addEventListener('click', async function(e){
          var act = e.target && e.target.dataset ? e.target.dataset.act : '';
          if (act === 'copy'){
            try{ await navigator.clipboard.writeText(ctxTargetText || ''); }catch(err){}
            hideCtx();
          }
          if (act === 'del'){
            if (!ctxTargetId) return;
            if (!confirm('このメッセージを削除します。よろしいですか？')) return;
            var r = await api('/admin/supports/' + encodeURIComponent(USER_ID) + '/api/delete', { messageId: ctxTargetId });
            hideCtx();
            if (!r.ok){ alert('削除に失敗しました'); return; }
            await load();
          }
        });

        // send (フォームはフォールバック)
        var sendForm = byId('sendForm');
        if (sendForm){
          sendForm.addEventListener('submit', async function(e){
            e.preventDefault();
            var ta = byId('text');
            var v = (ta.value||'').trim();
            if (!v) return;
            byId('sendBtn').disabled = true;
            try{
              var r = await api('/admin/supports/' + encodeURIComponent(USER_ID) + '/api/send', { text:v });
              byId('sendBtn').disabled = false;
              if (!r.ok){
                console.warn('send failed', r.status, r.json);
                sendForm.submit();
                return;
              }
              ta.value = '';
              await load();
            }catch(err){
              byId('sendBtn').disabled = false;
              sendForm.submit();
            }
          });
        }

        byId('text').addEventListener('keydown', function(e){
          if(e.key==='Enter' && (e.ctrlKey || e.metaKey)){
            e.preventDefault();
            byId('sendBtn').click();
          }
        });

        load();
      });
    </script>
  </body></html>`;
  res.send(html);
});

// admin form send
app.post("/admin/supports/:userId/send", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  const text = (req.body?.text ?? "").toString().trim();
  if (!text) return res.redirect("/admin/supports/" + encodeURIComponent(userId));
  if (text.length > 2000) return res.send(toastPage("⚠メッセージが長すぎます（2000文字まで）。", "/admin/supports/" + encodeURIComponent(userId)));
  await appendSupportMessageAsStaff(userId, req.user || null, text);
  return res.redirect("/admin/supports/" + encodeURIComponent(userId));
});

app.get("/admin/supports/:userId/api/thread", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  await db.read();
  await usersDb.read();

  const target = usersDb.data.users.find(x => x.id === userId) || null;
  const t = getSupportThread(userId, false);

  const viewer = { id: req.user?.id || null, username: req.user?.username || "admin", role: req.user?.role || ROLE_ADMIN, iconUrl: req.user?.iconUrl || null };
  return res.json({
    ok: true,
    viewer,
    target: target ? { id: target.id, username: target.username, role: target.role, iconUrl: target.iconUrl || null } : null,
    messages: hydrateSupportMessages((t?.messages || []), buildUsersMap()).map(normalizeMsgForClient),
  });
});

app.post("/admin/supports/:userId/api/send", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  const text = (req.body?.text ?? "").toString().trim();
  if (!text) return res.status(400).json({ ok:false, message:"空のメッセージは送信できません。" });
  if (text.length > 2000) return res.status(400).json({ ok:false, message:"メッセージが長すぎます（2000文字まで）。" });

  const msg = await appendSupportMessageAsStaff(userId, req.user || null, text);
  return res.json({ ok:true, message: normalizeMsgForClient(msg) });
});

app.post("/admin/supports/:userId/api/delete", requireAdmin, async (req, res) => {
  const userId = (req.params.userId || "").toString();
  const messageId = (req.body?.messageId ?? "").toString();
  if (!messageId) return res.status(400).json({ ok:false, message:"messageId が必要です。" });

  await db.read();
  const t = getSupportThread(userId, true);
  const before = t.messages.length;
  t.messages = t.messages.filter(m => m.id !== messageId);
  const after = t.messages.length;
  updateThreadMeta(t);
  await db.write();
  return res.json({ ok:true, removed: before - after });
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
