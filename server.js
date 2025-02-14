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

// Render の Environment Variables
const GITHUB_OWNER = process.env.GITHUB_OWNER; // 例: "housou0401"
const REPO_NAME = process.env.REPO_NAME;         // 例: "request-musicE"
const FILE_PATH = "db.json"; // リモート保存先（db.json 全体）
const BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;  // Personal Access Token

if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) {
  console.error("必要な環境変数が設定されていません。");
  process.exit(1);
}

// データベース設定（lowdb: responses, lastSubmissions, songCounts, settings）
const adapter = new JSONFileSync("db.json");
const db = new LowSync(adapter);
db.read();
db.data = db.data || { responses: [], lastSubmissions: {}, songCounts: {}, settings: {} };
if (!db.data.lastSubmissions) db.data.lastSubmissions = {};
if (!db.data.songCounts) db.data.songCounts = {};
if (!db.data.settings) {
  db.data.settings = {
    recruiting: true,
    reason: "",
    frontendTitle: "♬曲をリクエストする",
    adminPassword: "housou0401"
  };
  db.write();
} else {
  if (db.data.settings.frontendTitle === undefined) {
    db.data.settings.frontendTitle = "♬曲をリクエストする";
  }
  if (db.data.settings.adminPassword === undefined) {
    db.data.settings.adminPassword = "housou0401";
  }
  db.write();
}

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

/* --- Apple Music 検索関連 --- */
// 指定言語、entity でクエリ実行
const fetchResultsForQuery = async (query, lang, entity = "song") => {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=JP&media=music&entity=${entity}&limit=50&explicit=no&lang=${lang}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`HTTPエラー: ${response.status} for URL: ${url}`);
    return { results: [] };
  }
  const text = await response.text();
  if (text.trim() === "") return { results: [] };
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`JSON parse error for lang=${lang} and query=${query}:`, e);
    return { results: [] };
  }
};

// アーティストの曲一覧取得（lookup API）
const fetchArtistTracks = async (artistId) => {
  const url = `https://itunes.apple.com/lookup?id=${artistId}&entity=song&country=JP&limit=50`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`HTTPエラー: ${response.status} for URL: ${url}`);
    return [];
  }
  const text = await response.text();
  if (text.trim() === "") return [];
  try {
    const data = JSON.parse(text);
    if (!data.results || data.results.length <= 1) return [];
    // 先頭はアーティスト情報なので除外
    return data.results.slice(1).map(r => ({
      trackName: r.trackName,
      artistName: r.artistName,
      trackViewUrl: r.trackViewUrl,
      artworkUrl: r.artworkUrl100
    }));
  } catch (e) {
    console.error("JSON parse error (fetchArtistTracks):", e);
    return [];
  }
};

// 曲名検索用（song mode）
const fetchAppleMusicInfo = async (songTitle, artistName) => {
  try {
    const hasKorean  = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(songTitle);
    const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(songTitle);
    const hasEnglish  = /[A-Za-z]/.test(songTitle);
    let lang = hasKorean ? "ko_kr" : hasJapanese ? "ja_jp" : "en_us";
    
    let queries = [];
    if (artistName && artistName.trim().length > 0) {
      queries.push(`"${songTitle}" ${artistName}`);
      queries.push(`${songTitle} ${artistName}`);
      queries.push(`${songTitle} official ${artistName}`);
    } else {
      queries.push(`"${songTitle}"`);
      queries.push(`${songTitle} official`);
    }
    queries.push(songTitle);
    
    for (let query of queries) {
      let data;
      if (lang === "en_us" || lang === "en_gb") {
        data = await fetchResultsForQuery(query, lang, "song");
        if (!data || !data.results || data.results.length === 0) {
          const altLang = (lang === "en_us") ? "en_gb" : "en_us";
          data = await fetchResultsForQuery(query, altLang, "song");
        }
      } else {
        data = await fetchResultsForQuery(query, lang, "song");
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
              artworkUrl: track.artworkUrl100
            });
          }
        }
        if (uniqueResults.length > 0) return uniqueResults;
      }
    }
    return [];
  } catch (error) {
    console.error("❌ Apple Music 検索エラー (song mode):", error);
    return [];
  }
};

// /search エンドポイント
// mode = "song" または "artist"
app.get("/search", async (req, res) => {
  const mode = req.query.mode || "song";
  try {
    if (mode === "artist") {
      if (req.query.artistId) {
        // アーティストが選択済み → そのアーティストの曲一覧を返す
        const tracks = await fetchArtistTracks(req.query.artistId.trim());
        return res.json(tracks);
      } else {
        // アーティスト一覧検索：entity="album" を利用して代表画像を取得
        const query = req.query.query?.trim();
        if (!query || query.length === 0) return res.json([]);
        const hasKorean  = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(query);
        const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(query);
        const hasEnglish  = /[A-Za-z]/.test(query);
        let lang = hasKorean ? "ko_kr" : hasJapanese ? "ja_jp" : "en_us";
        const data = await fetchResultsForQuery(query, lang, "album");
        if (!data || !data.results) return res.json([]);
        const artistMap = new Map();
        for (let album of data.results) {
          if (album.artistName && album.artistId) {
            if (!artistMap.has(album.artistId)) {
              artistMap.set(album.artistId, {
                trackName: album.artistName, // Apple Music の正確なアーティスト名
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
      // songモード
      const query = req.query.query?.trim();
      const artist = req.query.artist?.trim() || "";
      if (!query || query.length === 0) return res.json([]);
      const suggestions = await fetchAppleMusicInfo(query, artist);
      return res.json(suggestions);
    }
  } catch (err) {
    console.error("❌ /search エラー:", err);
    return res.json([]);
  }
});

// リクエスト送信（曲選択必須）
app.post("/submit", async (req, res) => {
  if (!req.body.appleMusicUrl || !req.body.artworkUrl) {
    res.set("Content-Type", "text/html");
    return res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body><script>
alert("⚠️必ず候補一覧から曲を選択してください");
window.location.href="/";
</script></body></html>`);
  }
  const responseText = req.body.response?.trim();
  const artistText = req.body.artist?.trim() || "アーティスト不明";
  if (!responseText) {
    res.set("Content-Type", "text/html");
    return res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body><script>
alert("⚠️入力欄が空です。");
window.location.href="/";
</script></body></html>`);
  }
  const finalSongTitle = responseText;
  const finalArtistName = artistText;
  const key = `${finalSongTitle.toLowerCase()}|${finalArtistName.toLowerCase()}`;
  if (!db.data.songCounts[key]) {
    db.data.songCounts[key] = 1;
  } else {
    db.data.songCounts[key] += 1;
  }
  const existingEntry = db.data.responses.find(entry =>
    entry.text.toLowerCase() === finalSongTitle.toLowerCase() &&
    entry.artist.toLowerCase() === finalArtistName.toLowerCase()
  );
  if (existingEntry) {
    existingEntry.count = db.data.songCounts[key];
  } else {
    db.data.responses.push({
      id: nanoid(),
      text: finalSongTitle,
      artist: finalArtistName,
      appleMusicUrl: req.body.appleMusicUrl || "",
      artworkUrl: req.body.artworkUrl || "",
      count: 1
    });
  }
  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body><script>
alert("✅送信が完了しました！\\nリクエストありがとうございました！");
window.location.href="/";
</script></body></html>`);
});

// GitHub 同期用
async function syncRequestsToGitHub() {
  try {
    const localContent = JSON.stringify(db.data, null, 2);
    let sha;
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
        console.log("db.json が存在しないため、新規作成します。");
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
    console.log("✅ Sync 完了:", putResponse.data);
    return putResponse.data;
  } catch (error) {
    console.error("❌ Sync エラー:", error.response ? error.response.data : error.message);
    throw error;
  }
}

app.get("/sync-requests", async (req, res) => {
  try {
    await syncRequestsToGitHub();
    res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head>
<body>
<p style="font-size:18px; color:green;">✅ Sync 完了しました。3秒後に管理者ページに戻ります。</p>
</body></html>`);
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
    res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head>
<body>
<p style="font-size:18px; color:green;">✅ Fetch 完了しました。3秒後に管理者ページに戻ります。</p>
</body></html>`);
  } catch (error) {
    console.error("❌ Fetch エラー:", error.response ? error.response.data : error.message);
    res.send("Fetch エラー: " + (error.response ? JSON.stringify(error.response.data) : error.message));
  }
});

app.get("/admin", (req, res) => {
  let responseList = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>管理者ページ</title>
  <style>
    li { margin-bottom: 10px; }
    .entry-container { position: relative; display: inline-block; }
    .entry {
      display: flex;
      align-items: center;
      cursor: pointer;
      border: 1px solid rgba(0,0,0,0.1);
      padding: 10px;
      border-radius: 10px;
      width: fit-content;
    }
    .entry:hover { background-color: rgba(0,0,0,0.05); }
    .entry img { width: 50px; height: 50px; border-radius: 5px; margin-right: 10px; }
    .delete {
      position: absolute;
      left: calc(100% + 10px);
      top: 50%;
      transform: translateY(-50%);
      color: red;
      text-decoration: none;
    }
    .count-badge {
      background-color: #ff6b6b;
      color: white;
      font-weight: bold;
      padding: 4px 8px;
      border-radius: 5px;
      margin-right: 10px;
    }
    h1 { font-size: 1.5em; margin-bottom: 20px; }
    form { margin: 20px 0; text-align: left; }
    textarea {
      width: 300px;
      height: 80px;
      font-size: 0.9em;
      color: black;
      display: block;
      margin-bottom: 10px;
    }
    .setting-field { margin-bottom: 10px; }
    .sync-btn, .fetch-btn {
      padding: 12px 20px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 16px;
    }
    .sync-btn {
      background-color: #28a745;
      color: white;
    }
    .sync-btn:hover {
      background-color: #218838;
    }
    .fetch-btn {
      background-color: #17a2b8;
      color: white;
      margin-left: 10px;
    }
    .fetch-btn:hover {
      background-color: #138496;
    }
    .button-container {
      display: flex;
      justify-content: flex-start;
      margin-bottom: 10px;
    }
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
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .selected-label {
      font-size: 12px;
      color: #555;
      margin-top: 8px;
      margin-bottom: 8px;
      text-align: left;
    }
    @media (max-width: 600px) {
      .container, form, textarea, input[type="text"] {
        width: 95%;
      }
      .sync-btn, .fetch-btn {
        font-size: 14px;
        padding: 10px 16px;
      }
    }
    input, textarea {
      -webkit-text-size-adjust: 100%;
    }
    html, body {
      overscroll-behavior: contain;
    }
  </style>
</head>
<body>
<h1>✉アンケート回答一覧</h1>
<ul>`;
  for (let entry of db.data.responses) {
    responseList += `<li>
      <div class="entry-container">
        <a href="${(entry.appleMusicUrl && entry.appleMusicUrl !== "") ? entry.appleMusicUrl : "#"}" target="_blank" class="entry">
          <div class="count-badge">${entry.count}</div>
          <img src="${entry.artworkUrl}" alt="Cover">
          <div>
            <strong>${entry.text}</strong><br>
            <small>${entry.artist || "🎤アーティスト不明"}</small>
          </div>
        </a>
        <a href="/delete/${entry.id}" class="delete">🗑️</a>
      </div>
    </li>`;
  }
  responseList += `</ul>`;
  // 設定フォーム
  responseList += `<form action="/update-settings" method="post">
  <div class="setting-field">
    <label>
      <input type="checkbox" name="recruiting" value="off" ${db.data.settings.recruiting ? "" : "checked"} style="transform: scale(1.5); vertical-align: middle; margin-right: 10px;">
      募集を終了する
    </label>
  </div>
  <div class="setting-field">
    <label>理由:</label><br>
    <textarea name="reason" placeholder="理由（任意）" style="width:300px; height:80px; font-size:0.9em; color:black;">${db.data.settings.reason || ""}</textarea>
  </div>
  <div class="setting-field">
    <label>フロントエンドタイトル:</label><br>
    <textarea name="frontendTitle" placeholder="フロントエンドに表示するタイトル" style="width:300px; height:60px; font-size:0.9em; color:black;">${db.data.settings.frontendTitle || "♬曲をリクエストする"}</textarea>
  </div>
  <div class="setting-field">
    <label>管理者パスワード:</label><br>
    <input type="text" name="adminPassword" placeholder="新しい管理者パスワード" style="width:300px; padding:10px; font-size:0.9em;">
  </div>
  <br>
  <button type="submit" style="font-size:18px; padding:12px;">設定を更新</button>
</form>`;
  // 同期/取得ボタンと戻るボタン（戻るボタンを大きく）
  responseList += `<div class="button-container">
    <button class="sync-btn" id="syncBtn" onclick="syncToGitHub()">GitHubに同期</button>
    <button class="fetch-btn" id="fetchBtn" onclick="fetchFromGitHub()">GitHubから取得</button>
    <div class="spinner" id="loadingSpinner"></div>
  </div>`;
  responseList += `<br><a href='/' style="font-size:20px; padding:10px 20px; background-color:#007bff; color:white; border-radius:5px; text-decoration:none;">↵戻る</a>`;
  responseList += `
  <script>
    function syncToGitHub() {
      const syncBtn = document.getElementById("syncBtn");
      const fetchBtn = document.getElementById("fetchBtn");
      syncBtn.disabled = true;
      fetchBtn.disabled = true;
      document.getElementById("loadingSpinner").style.display = "block";
      fetch("/sync-requests")
        .then(response => response.text())
        .then(data => {
          document.body.innerHTML = data;
        })
        .catch(err => {
          alert("エラー: " + err);
          document.getElementById("loadingSpinner").style.display = "none";
          syncBtn.disabled = false;
          fetchBtn.disabled = false;
        });
    }
    function fetchFromGitHub() {
      const syncBtn = document.getElementById("syncBtn");
      const fetchBtn = document.getElementById("fetchBtn");
      syncBtn.disabled = true;
      fetchBtn.disabled = true;
      document.getElementById("loadingSpinner").style.display = "block";
      fetch("/fetch-requests")
        .then(response => response.text())
        .then(data => {
          document.body.innerHTML = data;
        })
        .catch(err => {
          alert("エラー: " + err);
          document.getElementById("loadingSpinner").style.display = "none";
          syncBtn.disabled = false;
          fetchBtn.disabled = false;
        });
    }
  </script>
  `;
  responseList += `</body></html>`;
  res.set("Content-Type", "text/html");
  res.send(responseList);
});

app.get("/delete/:id", (req, res) => {
  const id = req.params.id;
  db.data.responses = db.data.responses.filter(entry => entry.id !== id);
  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body><script>
alert("🗑️削除しました！");
window.location.href="/admin";
</script></body></html>`);
});

app.get("/admin-login", (req, res) => {
  const { password } = req.query;
  res.json({ success: password === db.data.settings.adminPassword });
});

app.post("/update-settings", (req, res) => {
  db.data.settings.recruiting = req.body.recruiting ? false : true;
  db.data.settings.reason = req.body.reason || "";
  db.data.settings.frontendTitle = req.body.frontendTitle || "♬曲をリクエストする";
  if (req.body.adminPassword && req.body.adminPassword.trim().length > 0) {
    db.data.settings.adminPassword = req.body.adminPassword.trim();
  }
  db.write();
  res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head>
<body>
<p style="font-size:18px; color:green;">設定を完了しました。</p>
</body></html>`);
});

app.get("/settings", (req, res) => {
  res.json(db.data.settings);
});

cron.schedule("*/20 * * * *", async () => {
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
