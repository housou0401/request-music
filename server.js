import express from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { LowSync, JSONFileSync } from "lowdb";
import { nanoid } from "nanoid";
import fetch from "node-fetch";
import cron from "node-cron";
import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// ====== Render の Environment Variables（Environment タブで設定） ======
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) {
  console.error("必要な環境変数(GITHUB_OWNER, REPO_NAME, GITHUB_TOKEN)が設定されていません。");
  process.exit(1);
}

// ====== LowDB のセットアップ（db.json / users.json） ======
const dbAdapter = new JSONFileSync("db.json");
const db = new LowSync(dbAdapter);
db.read();
db.data = db.data || { responses: [], songCounts: {}, settings: {} };
if (!db.data.songCounts) db.data.songCounts = {};
if (!db.data.settings) db.data.settings = {};

if (db.data.settings.recruiting === undefined) db.data.settings.recruiting = true;
if (db.data.settings.reason === undefined) db.data.settings.reason = "";
if (db.data.settings.frontendTitle === undefined) db.data.settings.frontendTitle = "♬曲をリクエストする";
if (db.data.settings.adminPassword === undefined) db.data.settings.adminPassword = "housou0401";
if (db.data.settings.playerControlsEnabled === undefined) db.data.settings.playerControlsEnabled = true;
// ★ 追加: 月次配布トークン数
if (db.data.settings.monthlyTokens === undefined) db.data.settings.monthlyTokens = 5;
db.write();

const usersAdapter = new JSONFileSync("users.json");
const usersDb = new LowSync(usersAdapter);
usersDb.read();
usersDb.data = usersDb.data || { users: [] }; // { id, username, deviceInfo, role('user'|'admin'), tokens(null|number), lastRefillISO('YYYY-MM') }
usersDb.write();

// ====== ミドルウェア ======
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json()); // JSONも受ける（/register など）
app.use(cookieParser());
app.use(express.static("public"));

// ====== ユーザー / トークン管理ユーティリティ ======
function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function isAdmin(user) {
  return user && user.role === "admin";
}
function getUserById(id) {
  return usersDb.data.users.find(u => u.id === id);
}
function ensureMonthlyRefillSync(user) {
  if (!user) return;
  if (isAdmin(user)) return; // 管理者は無制限
  const m = monthKey();
  const monthly = Number(db.data.settings.monthlyTokens ?? 5);
  if (user.lastRefillISO !== m) {
    user.tokens = monthly;
    user.lastRefillISO = m;
    usersDb.write();
  }
}
function deviceInfoFromReq(req) {
  return {
    ua: req.get("User-Agent") || "",
    ip: req.ip || req.connection?.remoteAddress || ""
  };
}

// Cookie→req.user 解決
function resolveUser(req, _res, next) {
  const deviceId = req.cookies?.deviceId;
  if (deviceId) {
    const u = getUserById(deviceId);
    if (u) {
      ensureMonthlyRefillSync(u);
      req.user = u;
    }
  }
  next();
}
app.use(resolveUser);

// ====== Apple Music 検索関連（既存） ======
async function fetchResultsForQuery(query, lang, entity = "song", attribute = "") {
  let url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=JP&media=music&entity=${entity}&limit=75&explicit=no&lang=${lang}`;
  if (attribute) url += `&attribute=${attribute}`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) {
    console.error(`HTTPエラー: ${response.status} for URL: ${url}`);
    return { results: [] };
  }
  const text = await response.text();
  if (!text.trim()) return { results: [] };
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`JSON parse error for url=${url}:`, e);
    return { results: [] };
  }
}

async function fetchArtistTracks(artistId) {
  const url = `https://itunes.apple.com/lookup?id=${artistId}&entity=song&country=JP&limit=75`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) {
    console.error(`HTTPエラー: ${response.status} for URL: ${url}`);
    return [];
  }
  const text = await response.text();
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text);
    if (!data.results || data.results.length <= 1) return [];
    return data.results.slice(1).map(r => ({
      trackName: r.trackName,
      artistName: r.artistName,
      trackViewUrl: r.trackViewUrl,
      artworkUrl: r.artworkUrl100,
      previewUrl: r.previewUrl || ""
    }));
  } catch (e) {
    console.error("JSON parse error (fetchArtistTracks):", e);
    return [];
  }
}

async function fetchAppleMusicInfo(songTitle, artistName) {
  try {
    const hasKorean  = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(songTitle);
    const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(songTitle);
    let lang = hasKorean ? "ko_kr" : hasJapanese ? "ja_jp" : "en_us";

    let queries = [];
    if (artistName && artistName.trim()) {
      queries.push(`${songTitle} ${artistName}`);
      queries.push(`${songTitle} official ${artistName}`);
    } else {
      queries.push(songTitle);
      queries.push(`${songTitle} official`);
    }

    for (let query of queries) {
      let data = await fetchResultsForQuery(query, lang, "song", "songTerm");
      if (data.results.length === 0 && (lang === "en_us" || lang === "en_gb")) {
        const altLang = (lang === "en_us") ? "en_gb" : "en_us";
        data = await fetchResultsForQuery(query, altLang, "song", "songTerm");
      }
      if (data && data.results && data.results.length > 0) {
        const uniqueResults = [];
        const seen = new Set();
        for (let track of data.results) {
          const key = (track.trackName + "|" + track.artistName).toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            uniqueResults.push({
              trackName: track.trackName,
              artistName: track.artistName,
              trackViewUrl: track.trackViewUrl,
              artworkUrl: track.artworkUrl100,
              previewUrl: track.previewUrl || ""
            });
          }
        }
        if (uniqueResults.length > 0) return uniqueResults;
      }
    }
    return [];
  } catch (error) {
    console.error("❌ Apple Music 検索エラー:", error);
    return [];
  }
}

// ====== API: 検索（既存のまま） ======
app.get("/search", async (req, res) => {
  const mode = req.query.mode || "song";
  try {
    if (mode === "artist") {
      if (req.query.artistId) {
        const tracks = await fetchArtistTracks(req.query.artistId.trim());
        return res.json(tracks);
      } else {
        const query = req.query.query?.trim();
        if (!query) return res.json([]);
        const hasKorean  = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(query);
        const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(query);
        let lang = hasKorean ? "ko_kr" : hasJapanese ? "ja_jp" : "en_us";
        const data = await fetchResultsForQuery(query, lang, "album", "artistTerm");
        if (!data || !data.results) return res.json([]);
        const artistMap = new Map();
        for (let album of data.results) {
          if (album.artistName && album.artistId) {
            if (!artistMap.has(album.artistId)) {
              artistMap.set(album.artistId, {
                trackName: album.artistName,
                artistName: album.artistName,
                artworkUrl: album.artworkUrl100 || "",
                artistId: album.artistId
              });
            }
          }
        }
        return res.json(Array.from(artistMap.values()));
      }
    } else {
      const query = req.query.query?.trim();
      const artist = req.query.artist?.trim() || "";
      if (!query) return res.json([]);
      const suggestions = await fetchAppleMusicInfo(query, artist);
      return res.json(suggestions);
    }
  } catch (err) {
    console.error("❌ /search エラー:", err);
    return res.json([]);
  }
});

// ====== API: 初回登録＆Cookie発行 ======
app.post("/register", (req, res) => {
  try {
    const username = (req.body.username || "Guest").toString().trim() || "Guest";
    const adminPassword = (req.body.adminPassword || "").toString().trim();
    const deviceId = nanoid(16);
    const role = adminPassword && adminPassword === db.data.settings.adminPassword ? "admin" : "user";
    const monthly = Number(db.data.settings.monthlyTokens ?? 5);

    const user = {
      id: deviceId,
      username,
      deviceInfo: deviceInfoFromReq(req),
      role,
      tokens: role === "admin" ? null : monthly,
      lastRefillISO: monthKey()
    };
    usersDb.data.users.push(user);
    usersDb.write();

    // Cookie: 端末＝1ユーザー
    res.cookie("deviceId", deviceId, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 1000 * 60 * 60 * 24 * 365 // 1年
    });

    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, tokens: user.tokens } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 自分の状態（残トークンなど）
app.get("/me", (req, res) => {
  const s = db.data.settings;
  if (!req.user) return res.json({ loggedIn: false, settings: { monthlyTokens: s.monthlyTokens } });
  ensureMonthlyRefillSync(req.user);
  res.json({
    loggedIn: true,
    user: { id: req.user.id, username: req.user.username, role: req.user.role, tokens: req.user.tokens },
    settings: { monthlyTokens: s.monthlyTokens }
  });
});

// ====== API: リクエスト送信（ここでトークン消費） ======
app.post("/submit", (req, res) => {
  // Cookieベースのユーザー必須
  const user = req.user;
  if (!user) {
    return res.send(`<script>alert("未登録です。初回登録をしてください。"); window.location.href="/";</script>`);
  }
  ensureMonthlyRefillSync(user);
  if (!isAdmin(user)) {
    if (typeof user.tokens !== "number" || user.tokens <= 0) {
      return res.send(`<script>alert("トークンが不足しています。"); window.location.href="/";</script>`);
    }
  }

  const appleMusicUrl = req.body.appleMusicUrl?.trim();
  const artworkUrl = req.body.artworkUrl?.trim();
  const previewUrl = req.body.previewUrl?.trim();
  if (!appleMusicUrl || !artworkUrl || !previewUrl) {
    return res.send(`<script>alert("必ず候補一覧から曲を選択してください"); window.location.href="/";</script>`);
  }
  const responseText = req.body.response?.trim();
  const artistText = req.body.artist?.trim() || "アーティスト不明";
  if (!responseText) {
    return res.send(`<script>alert("⚠️入力欄が空です。"); window.location.href="/";</script>`);
  }

  const key = `${responseText.toLowerCase()}|${artistText.toLowerCase()}`;
  db.data.songCounts[key] = (db.data.songCounts[key] || 0) + 1;

  const existing = db.data.responses.find(r =>
    r.text.toLowerCase() === responseText.toLowerCase() &&
    r.artist.toLowerCase() === artistText.toLowerCase()
  );
  if (existing) {
    existing.count = db.data.songCounts[key];
  } else {
    db.data.responses.push({
      id: nanoid(),
      text: responseText,
      artist: artistText,
      appleMusicUrl,
      artworkUrl,
      previewUrl,
      count: db.data.songCounts[key],
      createdAt: new Date().toISOString(),
      by: { id: user.id, username: user.username }
    });
  }

  // トークン消費（管理者は無制限）
  if (!isAdmin(user)) {
    user.tokens = Math.max(0, (user.tokens ?? 0) - 1);
    usersDb.write();
  }

  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  res.send(`<script>alert("✅送信が完了しました！\\nリクエストありがとうございました！"); window.location.href="/";</script>`);
});

// ====== API: リクエスト削除（既存。回数リセット） ======
app.get("/delete/:id", (req, res) => {
  const id = req.params.id;
  const toDelete = db.data.responses.find(entry => entry.id === id);
  if (toDelete) {
    const key = `${toDelete.text.toLowerCase()}|${toDelete.artist.toLowerCase()}`;
    delete db.data.songCounts[key];
  }
  db.data.responses = db.data.responses.filter(entry => entry.id !== id);
  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  res.set("Content-Type", "text/html");
  res.send(`<script>alert("🗑️削除しました！"); window.location.href="/admin";</script>`);
});

// ====== GitHub 同期/取得（db.json と users.json の両方） ======
async function getFileSha(pathname) {
  try {
    const r = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${pathname}?ref=${BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    return r.data.sha;
  } catch (e) {
    if (e.response && e.response.status === 404) return null;
    throw e;
  }
}

async function putFile(pathname, contentObj, message) {
  const sha = await getFileSha(pathname);
  const contentEncoded = Buffer.from(JSON.stringify(contentObj, null, 2)).toString("base64");
  const payload = { message, content: contentEncoded, branch: BRANCH };
  if (sha) payload.sha = sha;
  const r = await axios.put(
    `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${pathname}`,
    payload,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
  );
  return r.data;
}

async function getFile(pathname) {
  const r = await axios.get(
    `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${pathname}?ref=${BRANCH}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
  );
  const contentBase64 = r.data.content;
  return JSON.parse(Buffer.from(contentBase64, "base64").toString("utf8"));
}

async function syncAllToGitHub() {
  await putFile("db.json", db.data, `Sync db.json at ${new Date().toISOString()}`);
  await putFile("users.json", usersDb.data, `Sync users.json at ${new Date().toISOString()}`);
}

async function fetchAllFromGitHub() {
  try {
    const dbRemote = await getFile("db.json");
    db.data = dbRemote;
    db.write();
    fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  } catch (e) {
    console.warn("fetch db.json failed:", e.message);
  }
  try {
    const usersRemote = await getFile("users.json");
    usersDb.data = usersRemote;
    usersDb.write();
    fs.writeFileSync("users.json", JSON.stringify(usersDb.data, null, 2));
  } catch (e) {
    console.warn("fetch users.json failed:", e.message);
  }
}

app.get("/sync-requests", async (req, res) => {
  try {
    await syncAllToGitHub();
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head><body><p style="font-size:18px; color:green;">✅ Sync 完了しました。3秒後に管理者ページに戻ります。</p><script>setTimeout(()=>{ location.href="/admin"; },3000);</script></body></html>`);
  } catch (e) {
    res.send("Sync エラー: " + (e.response ? JSON.stringify(e.response.data) : e.message));
  }
});

app.get("/fetch-requests", async (req, res) => {
  try {
    await fetchAllFromGitHub();
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head><body><p style="font-size:18px; color:green;">✅ Fetch 完了しました。3秒後に管理者ページに戻ります。</p><script>setTimeout(()=>{ location.href="/admin"; },3000);</script></body></html>`);
  } catch (error) {
    res.send("Fetch エラー: " + (error.response ? JSON.stringify(error.response.data) : error.message));
  }
});

// ====== 管理ページ（既存＋ユーザー管理リンク／月次トークン設定） ======
app.get("/admin", (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const perPage = 10;
  const total = db.data.responses.length;
  const totalPages = Math.ceil(Math.max(total, 1) / perPage);
  const startIndex = (page - 1) * perPage;
  const pageItems = db.data.responses.slice(startIndex, startIndex + perPage);

  function createPaginationLinks(currentPage, totalPages) {
    let html = `<div style="text-align:left; margin-bottom:10px;">`;
    html += `<a href="?page=1" style="margin:0 5px;">|< 最初のページ</a>`;
    const prevPage = Math.max(1, currentPage - 1);
    html += `<a href="?page=${prevPage}" style="margin:0 5px;">&lt;</a>`;
    for (let p = 1; p <= totalPages; p++) {
      if (Math.abs(p - currentPage) <= 2 || p === 1 || p === totalPages) {
        if (p === currentPage) {
          html += `<span style="margin:0 5px; font-weight:bold;">${p}</span>`;
        } else {
          html += `<a href="?page=${p}" style="margin:0 5px;">${p}</a>`;
        }
      } else if (Math.abs(p - currentPage) === 3) {
        html += `...`;
      }
    }
    const nextPage = Math.min(totalPages, currentPage + 1);
    html += `<a href="?page=${nextPage}" style="margin:0 5px;">&gt;</a>`;
    html += `<a href="?page=${totalPages}" style="margin:0 5px;">最後のページ &gt;|</a>`;
    html += `</div>`;
    return html;
  }

  let html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>管理者ページ</title>
  <style>
    li { margin-bottom: 10px; }
    .entry-container { position: relative; display: inline-block; margin-bottom:10px; }
    .entry { display: flex; align-items: center; cursor: pointer; border: 1px solid rgba(0,0,0,0.1); padding: 10px; border-radius: 10px; width: fit-content; }
    .entry:hover { background-color: rgba(0,0,0,0.05); }
    .entry img { width: 50px; height: 50px; border-radius: 5px; margin-right: 10px; }
    .delete { position: absolute; left: calc(100% + 10px); top: 50%; transform: translateY(-50%); color: red; text-decoration: none; }
    .count-badge { background-color: #ff6b6b; color: white; font-weight: bold; padding: 4px 8px; border-radius: 5px; margin-right: 10px; }
    h1 { font-size: 1.5em; margin-bottom: 20px; }
    form { margin: 20px 0; text-align: left; }
    textarea { width: 300px; height: 80px; font-size: 0.9em; color: black; display: block; margin-bottom: 10px; }
    .setting-field { margin-bottom: 10px; }
    .sync-btn, .fetch-btn {
      padding: 12px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px;
    }
    .sync-btn { background-color: #28a745; color: white; }
    .sync-btn:hover { background-color: #218838; }
    .fetch-btn { background-color: #17a2b8; color: white; margin-left: 10px; }
    .fetch-btn:hover { background-color: #138496; }
    .button-container { display: flex; justify-content: flex-start; margin-bottom: 10px; }
    .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; display: none; margin-left: 10px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
  </head><body><h1>✉アンケート回答一覧</h1>`;
  html += createPaginationLinks(page, totalPages);
  html += `<ul style="list-style:none; padding:0;">`;
  pageItems.forEach(entry => {
    html += `<li>
      <div class="entry-container">
        <a href="${entry.appleMusicUrl || "#"}" target="_blank" class="entry">
          <div class="count-badge">${entry.count}</div>
          <img src="${entry.artworkUrl}" alt="Cover">
          <div>
            <strong>${entry.text}</strong><br>
            <small>${entry.artist}</small>
          </div>
        </a>
        <a href="/delete/${entry.id}" class="delete">🗑️</a>
      </div>
    </li>`;
  });
  html += `</ul>`;
  html += createPaginationLinks(page, totalPages);

  html += `<form action="/update-settings" method="post">
    <div class="setting-field">
      <label>
        <input type="checkbox" name="recruiting" value="off" ${db.data.settings.recruiting ? "" : "checked"} style="transform: scale(1.5); vertical-align: middle; margin-right: 10px;">
        募集を終了する
      </label>
    </div>
    <div class="setting-field">
      <label>理由:</label><br>
      <textarea name="reason" placeholder="理由（任意）">${db.data.settings.reason || ""}</textarea>
    </div>
    <div class="setting-field">
      <label>フロントエンドタイトル:</label><br>
      <textarea name="frontendTitle" placeholder="フロントエンドに表示するタイトル">${db.data.settings.frontendTitle || "♬曲をリクエストする"}</textarea>
    </div>
    <div class="setting-field">
      <label>管理者パスワード:</label><br>
      <input type="text" name="adminPassword" placeholder="新しい管理者パスワード" style="width:300px; padding:10px;">
    </div>
    <div class="setting-field">
      <label>
        <input type="checkbox" name="playerControlsEnabled" value="on" ${db.data.settings.playerControlsEnabled ? "checked" : ""} style="transform: scale(1.5); vertical-align: middle; margin-right: 10px;">
        ユーザーページの再生・音量ボタンを表示する
      </label>
    </div>
    <br>
    <button type="submit" style="font-size:18px; padding:12px;">設定を更新</button>
  </form>`;

  // 追加: 月次トークン設定＆ユーザー管理リンク
  html += `<h2>月次トークン</h2>
  <form method="POST" action="/admin/update-monthly-tokens" style="margin-bottom:16px;">
    <label>月次配布数: <input type="number" min="0" name="monthlyTokens" value="${db.data.settings.monthlyTokens ?? 5}" style="width:100px;"></label>
    <button type="submit" style="margin-left:8px;">保存</button>
  </form>
  <p><a href="/admin/users" style="font-size:16px;">ユーザー管理へ →</a></p>`;

  html += `<div class="button-container">
    <button class="sync-btn" id="syncBtn" onclick="syncToGitHub()">GitHubに同期</button>
    <button class="fetch-btn" id="fetchBtn" onclick="fetchFromGitHub()">GitHubから取得</button>
    <div class="spinner" id="loadingSpinner"></div>
  </div>
  <br><a href="/" style="font-size:20px; padding:10px 20px; background-color:#007bff; color:white; border-radius:5px; text-decoration:none;">↵戻る</a>`;
  html += `<script>
    function syncToGitHub() {
      document.getElementById("syncBtn").disabled = true;
      document.getElementById("fetchBtn").disabled = true;
      document.getElementById("loadingSpinner").style.display = "block";
      fetch("/sync-requests")
        .then(r => r.text())
        .then(d => { document.body.innerHTML = d; })
        .catch(e => {
          alert("エラー: " + e);
          document.getElementById("loadingSpinner").style.display = "none";
          document.getElementById("syncBtn").disabled = false;
          document.getElementById("fetchBtn").disabled = false;
        });
    }
    function fetchFromGitHub() {
      document.getElementById("syncBtn").disabled = true;
      document.getElementById("fetchBtn").disabled = true;
      document.getElementById("loadingSpinner").style.display = "block";
      fetch("/fetch-requests")
        .then(r => r.text())
        .then(d => { document.body.innerHTML = d; })
        .catch(e => {
          alert("エラー: " + e);
          document.getElementById("loadingSpinner").style.display = "none";
          document.getElementById("syncBtn").disabled = false;
          document.getElementById("fetchBtn").disabled = false;
        });
    }
  </script>`;
  html += `</body></html>`;
  res.send(html);
});

// 管理: 月次配布数の保存
app.post("/admin/update-monthly-tokens", (req, res) => {
  const n = Number(req.body.monthlyTokens);
  if (!Number.isFinite(n) || n < 0) {
    return res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head><body><p style="font-size:18px; color:red;">入力が不正です。</p><script>setTimeout(()=>{ location.href="/admin"; },3000);</script></body></html>`);
  }
  db.data.settings.monthlyTokens = n;
  db.write();
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="1;url=/admin"></head><body><p style="font-size:18px; color:green;">保存しました。</p><script>setTimeout(()=>{ location.href="/admin"; },1000);</script></body></html>`);
});

// 管理: ユーザー一覧
app.get("/admin/users", (_req, res) => {
  usersDb.read();
  const rows = usersDb.data.users.map(u => `
    <tr>
      <td>${u.username}</td>
      <td>${u.id}</td>
      <td>${u.role}</td>
      <td>${isAdmin(u) ? "∞" : (u.tokens ?? 0)}</td>
      <td>${u.lastRefillISO || "-"}</td>
      <td>
        <form method="POST" action="/admin/update-user" style="display:flex; gap:6px; align-items:center;">
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
      </td>
    </tr>
  `).join("");

  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>Admin Users</title></head>
  <body>
    <h1>Users</h1>
    <p>Monthly tokens: ${db.data.settings.monthlyTokens}</p>
    <p><a href="/admin">← Adminへ戻る</a></p>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead><tr><th>username</th><th>deviceId</th><th>role</th><th>tokens</th><th>lastRefill</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </body></html>`);
});

// 管理: 個別ユーザー更新
app.post("/admin/update-user", (req, res) => {
  const { id, tokens, role } = req.body || {};
  const u = usersDb.data.users.find(x => x.id === id);
  if (!u) return res.status(404).send("Not found");

  if (role === "admin") {
    u.role = "admin";
    u.tokens = null; // 無制限
  } else {
    u.role = "user";
    const n = Number(tokens);
    u.tokens = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  usersDb.write();
  res.redirect(`/admin/users`);
});

// ====== 既存: 管理ログイン・設定 ======
app.get("/admin-login", (req, res) => {
  const { password } = req.query;
  res.json({ success: password === db.data.settings.adminPassword });
});

app.post("/update-settings", (req, res) => {
  db.data.settings.recruiting = req.body.recruiting ? false : true;
  db.data.settings.reason = req.body.reason || "";
  db.data.settings.frontendTitle = req.body.frontendTitle || "♬曲をリクエストする";
  if (req.body.adminPassword && req.body.adminPassword.trim()) {
    db.data.settings.adminPassword = req.body.adminPassword.trim();
  }
  db.data.settings.playerControlsEnabled = !!req.body.playerControlsEnabled;
  db.write();
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head><body><p style="font-size:18px; color:green;">設定を完了しました。3秒後に戻ります。</p><script>setTimeout(()=>{ location.href="/admin"; },3000);</script></body></html>`);
});

app.get("/settings", (req, res) => {
  res.json(db.data.settings);
});

// ====== 8分ごと自動同期（db.json / users.json） ======
cron.schedule("*/8 * * * *", async () => {
  console.log("自動更新ジョブ開始: db.json / users.json を GitHub にアップロードします。");
  try {
    db.write(); usersDb.write();
    await syncAllToGitHub();
    console.log("自動更新完了");
  } catch (e) {
    console.error("自動更新エラー:", e);
  }
});

app.listen(PORT, () => {
  console.log(`🚀サーバーが http://localhost:${PORT} で起動しました`);
});
