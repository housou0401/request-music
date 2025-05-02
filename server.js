import express from "express";
import bodyParser from "body-parser";
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
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME    = process.env.REPO_NAME;
const FILE_PATH    = "db.json";
const BRANCH       = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) {
  console.error("必要な環境変数が設定されていません。");
  process.exit(1);
}

// LowDB 初期化
const adapter = new JSONFileSync("db.json");
const db = new LowSync(adapter);
db.read();
db.data = db.data || { responses: [], songCounts: {}, settings: {} };
if (!db.data.settings) {
  db.data.settings = {
    recruiting: true,
    reason: "",
    frontendTitle: "♬曲をリクエストする",
    adminPassword: "housou0401",
    playerControlsEnabled: true
  };
  db.write();
} else if (db.data.settings.playerControlsEnabled === undefined) {
  db.data.settings.playerControlsEnabled = true;
  db.write();
}

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

/** 共通：iTunes API 呼び出し **/
async function fetchResultsForQuery(query, lang, entity) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=JP&media=music&entity=${entity}&limit=50&explicit=no&lang=${lang}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    console.error(`HTTPエラー: ${res.status} URL: ${url}`);
    return { results: [] };
  }
  const text = await res.text();
  if (!text.trim()) return { results: [] };
  try { return JSON.parse(text); }
  catch (e) {
    console.error(`JSON parse error (${url}):`, e);
    return { results: [] };
  }
}

// アーティスト→曲一覧
async function fetchArtistTracks(artistId) {
  const url = `https://itunes.apple.com/lookup?id=${artistId}&entity=song&country=JP&limit=50`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    console.error(`HTTPエラー: ${res.status} URL: ${url}`);
    return [];
  }
  const text = await res.text();
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text);
    return (data.results || []).slice(1).map(r => ({
      trackName:   r.trackName,
      artistName:  r.artistName,
      trackViewUrl:r.trackViewUrl,
      artworkUrl:  r.artworkUrl100,
      previewUrl:  r.previewUrl || ""
    }));
  } catch (e) {
    console.error("JSON parse error (fetchArtistTracks):", e);
    return [];
  }
}

// 曲検索
async function fetchAppleMusicInfo(songTitle, artistName) {
  try {
    const hasKorean   = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(songTitle);
    const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(songTitle);
    let lang = hasKorean ? "ko_kr" : hasJapanese ? "ja_jp" : "en_us";

    // クエリ候補
    const queries = artistName?.trim()
      ? [ `${songTitle} ${artistName}`, `${songTitle} official ${artistName}` ]
      : [ songTitle, `${songTitle} official` ];

    for (let q of queries) {
      let data = await fetchResultsForQuery(q, lang, "song");
      // 英語圏なら en_us⇔en_gb も試す
      if (!data.results.length && (lang === "en_us" || lang === "en_gb")) {
        const alt = lang === "en_us" ? "en_gb" : "en_us";
        data = await fetchResultsForQuery(q, alt, "song");
      }
      if (data.results.length) {
        const uniq = [], seen = new Set();
        for (let t of data.results) {
          const key = (t.trackName + "|" + t.artistName).toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            uniq.push({
              trackName:   t.trackName,
              artistName:  t.artistName,
              trackViewUrl:t.trackViewUrl,
              artworkUrl:  t.artworkUrl100,
              previewUrl:  t.previewUrl || ""
            });
          }
        }
        if (uniq.length) return uniq;
      }
    }
    return [];
  } catch (e) {
    console.error("曲検索エラー:", e);
    return [];
  }
}

/** /search エンドポイント **/
app.get("/search", async (req, res) => {
  const mode = req.query.mode || "song";
  try {
    if (mode === "artist") {
      const q = req.query.query?.trim();
      if (req.query.artistId) {
        return res.json(await fetchArtistTracks(req.query.artistId.trim()));
      }
      if (!q) return res.json([]);
      // ★ ここを album→musicArtist ではなく、entity=musicArtist で属性なし
      const hasKorean   = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(q);
      const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(q);
      const lang = hasKorean ? "ko_kr" : hasJapanese ? "ja_jp" : "en_us";
      const data = await fetchResultsForQuery(q, lang, "musicArtist");
      const map = new Map();
      for (let a of data.results || []) {
        if (a.artistId && a.artistName) {
          map.set(a.artistId, {
            trackName:  a.artistName,
            artistName: a.artistName,
            artworkUrl: a.artworkUrl100 || "",
            artistId:   a.artistId
          });
        }
      }
      return res.json(Array.from(map.values()));
    } else {
      const q  = req.query.query?.trim();
      const ar = req.query.artist?.trim() || "";
      if (!q) return res.json([]);
      return res.json(await fetchAppleMusicInfo(q, ar));
    }
  } catch (e) {
    console.error("/search エラー:", e);
    return res.json([]);
  }
});

/* リクエスト送信 */
app.post("/submit", (req, res) => {
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
      count: db.data.songCounts[key]
    });
  }
  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  res.send(`<script>alert("✅送信が完了しました！\\nリクエストありがとうございました！"); window.location.href="/";</script>`);
});

/* リクエスト削除（リクエスト回数もリセット） */
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

/* GitHub 同期/取得 */
async function syncRequestsToGitHub() {
  const localContent = JSON.stringify(db.data, null, 2);
  let sha = null;
  try {
    const getResponse = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );
    sha = getResponse.data.sha;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      sha = null;
    } else {
      throw err;
    }
  }
  const contentEncoded = Buffer.from(localContent).toString("base64");
  const putData = {
    message: "Sync db.json",
    content: contentEncoded,
    branch: BRANCH,
  };
  if (sha) putData.sha = sha;
  const putResponse = await axios.put(
    `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
    putData,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );
  return putResponse.data;
}

app.get("/sync-requests", async (req, res) => {
  try {
    await syncRequestsToGitHub();
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head><body><p style="font-size:18px; color:green;">✅ Sync 完了しました。3秒後に管理者ページに戻ります。</p><script>setTimeout(()=>{ location.href="/admin"; },3000);</script></body></html>`);
  } catch (e) {
    res.send("Sync エラー: " + (e.response ? JSON.stringify(e.response.data) : e.message));
  }
});

app.get("/fetch-requests", async (req, res) => {
  try {
    const getResponse = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );
    const contentBase64 = getResponse.data.content;
    const content = Buffer.from(contentBase64, "base64").toString("utf8");
    db.data = JSON.parse(content);
    db.write();
    fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head><body><p style="font-size:18px; color:green;">✅ Fetch 完了しました。3秒後に管理者ページに戻ります。</p><script>setTimeout(()=>{ location.href="/admin"; },3000);</script></body></html>`);
  } catch (error) {
    res.send("Fetch エラー: " + (error.response ? JSON.stringify(error.response.data) : error.message));
  }
});

app.get("/admin", (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const perPage = 10;
  const total = db.data.responses.length;
  const totalPages = Math.ceil(total / perPage);
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
      padding: 12px 20px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 16px;
    }
    .sync-btn { background-color: #28a745; color: white; }
    .sync-btn:hover { background-color: #218838; }
    .fetch-btn { background-color: #17a2b8; color: white; margin-left: 10px; }
    .fetch-btn:hover { background-color: #138496; }
    .button-container { display: flex; justify-content: flex-start; margin-bottom: 10px; }
    .spinner {
      border: 4px solid #f3f3f3;
      border-top: 4px solid #3498db;
      border-radius: 50%;
      width: 30px;
      height: 30px;
      animation: spin 1s linear infinite;
      display: none;
      margin-left: 10px;
    }
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

// 20分ごと自動同期
cron.schedule("*/10 * * * *", async () => {
  console.log("自動更新ジョブ開始: db.json を GitHub にアップロードします。");
  try {
    await syncRequestsToGitHub();
    console.log("自動更新完了");
  } catch (e) {
    console.error("自動更新エラー:", e);
  }
});

app.listen(PORT, () => {
  console.log(`🚀サーバーが http://localhost:${PORT} で起動しました`);
});
