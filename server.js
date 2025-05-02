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

// GitHub 同期用環境変数
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME    = process.env.REPO_NAME;
const FILE_PATH    = "db.json";
const BRANCH       = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) {
  console.error("必要な環境変数が設定されていません。");
  process.exit(1);
}

// LowDB セットアップ
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
}

// ミドルウェア
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

//――――――――――――――――――――――
// iTunes Search API ヘルパー
//――――――――――――――――――――――

// レートリミット対策：呼び出し間隔を 500ms 開ける
let lastFetchTime = 0;
async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const delta = now - lastFetchTime;
  if (delta < 500) {
    await new Promise(r => setTimeout(r, 500 - delta));
  }
  lastFetchTime = Date.now();
  return fetch(url, options);
}

/**
 * iTunes Search API 呼び出し
 * @param {string} query   検索語
 * @param {string} entity  musicTrack, musicArtist, album など
 * @param {number} limit   最大取得件数
 */
async function fetchResultsForQuery(query, entity, limit = 100) {
  const url = [
    `https://itunes.apple.com/search`,
    `?term=${encodeURIComponent(query)}`,
    `&country=JP&media=music`,
    `&entity=${entity}`,
    `&limit=${limit}`,
    `&explicit=no`
  ].join("");

  const res = await rateLimitedFetch(url, {
    headers: {
      "User-Agent": "MyApp/1.0",
      "Accept":      "application/json"
    }
  });

  if (!res.ok) {
    console.error(`HTTPエラー: ${res.status} URL: ${url}`);
    return { results: [] };
  }
  const text = await res.text();
  if (!text.trim()) return { results: [] };

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`JSONパースエラー: ${e.message}`);
    return { results: [] };
  }
}

// アーティストの曲一覧取得
async function fetchArtistTracks(artistId) {
  const url = [
    `https://itunes.apple.com/lookup`,
    `?id=${encodeURIComponent(artistId)}`,
    `&entity=musicTrack&country=JP&limit=100&explicit=no`
  ].join("");

  const res = await rateLimitedFetch(url, {
    headers: { "User-Agent": "MyApp/1.0", "Accept": "application/json" }
  });
  if (!res.ok) {
    console.error(`HTTPエラー: ${res.status} URL: ${url}`);
    return [];
  }
  const text = await res.text();
  if (!text.trim()) return [];

  try {
    const data = JSON.parse(text);
    // 最初の１件はアーティスト情報なので除去
    return (data.results || []).slice(1).map(r => ({
      trackName:    r.trackName,
      artistName:   r.artistName,
      trackViewUrl: r.trackViewUrl,
      artworkUrl:   r.artworkUrl100,
      previewUrl:   r.previewUrl || ""
    }));
  } catch (e) {
    console.error(`JSONパースエラー(fetchArtistTracks): ${e.message}`);
    return [];
  }
}

// 曲検索
async function fetchAppleMusicInfo(songTitle, artistName) {
  try {
    let queries = [];
    if (artistName) {
      queries.push(`${songTitle} ${artistName}`);
    }
    queries.push(songTitle);

    for (let q of queries) {
      const data = await fetchResultsForQuery(q, "musicTrack", 100);
      if (data.results && data.results.length) {
        const seen = new Set();
        const unique = data.results.map(track => ({
          trackName:    track.trackName,
          artistName:   track.artistName,
          trackViewUrl: track.trackViewUrl,
          artworkUrl:   track.artworkUrl100,
          previewUrl:   track.previewUrl || ""
        })).filter(t => {
          const key = (t.trackName + "|" + t.artistName).toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (unique.length) return unique;
      }
    }
    return [];
  } catch (err) {
    console.error("検索エラー(fetchAppleMusicInfo):", err);
    return [];
  }
}

//――――――――――――――――――――――
// エンドポイント定義
//――――――――――――――――――――――

app.get("/search", async (req, res) => {
  const mode = req.query.mode || "song";
  if (mode === "artist") {
    // アーティスト一覧取得
    if (req.query.artistId) {
      return res.json(await fetchArtistTracks(req.query.artistId));
    }
    const q = (req.query.query || "").trim();
    if (!q) return res.json([]);
    const data = await fetchResultsForQuery(q, "musicArtist", 100);
    const map = new Map();
    (data.results || []).forEach(a => {
      if (a.artistId && !map.has(a.artistId)) {
        map.set(a.artistId, {
          trackName:  a.artistName,
          artworkUrl: a.artworkUrl100,
          artistId:   a.artistId
        });
      }
    });
    return res.json(Array.from(map.values()));
  } else {
    // 曲検索
    const q      = (req.query.query || "").trim();
    const artist = (req.query.artist || "").trim();
    if (!q) return res.json([]);
    return res.json(await fetchAppleMusicInfo(q, artist));
  }
});

/* リクエスト送信 */
app.post("/submit", (req, res) => {
  const appleMusicUrl = req.body.appleMusicUrl?.trim();
  const artworkUrl    = req.body.artworkUrl?.trim();
  const previewUrl    = req.body.previewUrl?.trim();
  if (!appleMusicUrl || !artworkUrl || !previewUrl) {
    return res.send(`<script>alert("必ず候補一覧から曲を選択してください"); window.location.href="/";</script>`);
  }
  const responseText = req.body.response?.trim();
  const artistText   = req.body.artist?.trim() || "アーティスト不明";
  if (!responseText) {
    return res.send(`<script>alert("⚠️入力欄が空です。"); window.location.href="/";</script>`);
  }

  // 件数管理
  const key = `${responseText.toLowerCase()}|${artistText.toLowerCase()}`;
  db.data.songCounts[key] = (db.data.songCounts[key] || 0) + 1;

  // 重複チェック＆登録
  const existing = db.data.responses.find(r =>
    r.text.toLowerCase() === responseText.toLowerCase() &&
    r.artist.toLowerCase() === artistText.toLowerCase()
  );
  if (existing) {
    existing.count = db.data.songCounts[key];
  } else {
    db.data.responses.push({
      id:           nanoid(),
      text:         responseText,
      artist:       artistText,
      appleMusicUrl,
      artworkUrl,
      previewUrl,
      count:        db.data.songCounts[key]
    });
  }
  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));

  res.send(`<script>alert("✅送信が完了しました！\\nリクエストありがとうございました！"); window.location.href="/";</script>`);
});

/* リクエスト削除（回数リセット含む） */
app.get("/delete/:id", (req, res) => {
  const id = req.params.id;
  const toDelete = db.data.responses.find(e => e.id === id);
  if (toDelete) {
    const key = `${toDelete.text.toLowerCase()}|${toDelete.artist.toLowerCase()}`;
    delete db.data.songCounts[key];
  }
  db.data.responses = db.data.responses.filter(e => e.id !== id);
  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  res.send(`<script>alert("🗑️削除しました！"); window.location.href="/admin";</script>`);
});

/* GitHub 同期/取得 ヘルパー */
async function syncRequestsToGitHub() {
  const localContent = JSON.stringify(db.data, null, 2);
  let sha = null;
  try {
    const getRes = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
    sha = getRes.data.sha;
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }
  const contentEncoded = Buffer.from(localContent).toString("base64");
  const putData = { message: "Sync db.json", content: contentEncoded, branch: BRANCH };
  if (sha) putData.sha = sha;
  return axios.put(
    `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
    putData,
    { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
  );
}

app.get("/sync-requests", async (req, res) => {
  try {
    await syncRequestsToGitHub();
    res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head><body><p style="color:green;font-size:18px;">✅ Sync 完了しました。3秒後に管理者ページに戻ります。</p></body></html>`);
  } catch (e) {
    res.send("Sync エラー: " + (e.response ? JSON.stringify(e.response.data) : e.message));
  }
});

app.get("/fetch-requests", async (req, res) => {
  try {
    const getRes = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
    const content = Buffer.from(getRes.data.content, "base64").toString("utf8");
    db.data = JSON.parse(content);
    db.write();
    fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
    res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head><body><p style="color:green;font-size:18px;">✅ Fetch 完了しました。3秒後に管理者ページに戻ります。</p></body></html>`);
  } catch (err) {
    res.send("Fetch エラー: " + (err.response ? JSON.stringify(err.response.data) : err.message));
  }
});

app.get("/admin-login", (req, res) => {
  res.json({ success: req.query.password === db.data.settings.adminPassword });
});

app.get("/admin", (req, res) => {
  const page     = parseInt(req.query.page || "1", 10);
  const perPage  = 10;
  const total    = db.data.responses.length;
  const totalPgs = Math.ceil(total / perPage);
  const start    = (page - 1) * perPage;
  const items    = db.data.responses.slice(start, start + perPage);

  // ページャー作成
  function pager(cur) {
    let h = `<div style="text-align:left;margin-bottom:10px;">`;
    h += `<a href="?page=1">|< 最初</a> `;
    h += `<a href="?page=${Math.max(1,cur-1)}">&lt;</a> `;
    for (let i=1;i<=totalPgs;i++){
      if (i===cur) h += `<strong>${i}</strong> `;
      else if (Math.abs(i-cur)<=2||i===1||i===totalPgs) h += `<a href="?page=${i}">${i}</a> `;
      else if (Math.abs(i-cur)===3) h += `... `;
    }
    h += `<a href="?page=${Math.min(totalPgs,cur+1)}">&gt;</a> `;
    h += `<a href="?page=${totalPgs}">最後 >|</a>`;
    h += `</div>`;
    return h;
  }

  let html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>管理者ページ</title><style>
    /* （スタイル省略）同上のものをご利用ください */
  </style></head><body>`;
  html += `<h1>✉ アンケート回答一覧</h1>`;
  html += pager(page);
  html += `<ul style="list-style:none;padding:0;">`;
  items.forEach(e => {
    html += `<li><div style="display:inline-block;position:relative;margin:5px;">
      <a href="${e.appleMusicUrl||"#"}" target="_blank" style="display:flex;align-items:center;border:1px solid #ddd;padding:10px;border-radius:10px;">
        <span style="background:#f66;color:#fff;padding:4px 8px;border-radius:5px;margin-right:10px;">${e.count}</span>
        <img src="${e.artworkUrl}" width="50" height="50" style="border-radius:5px;margin-right:10px;">
        <div><strong>${e.text}</strong><br><small>${e.artist}</small></div>
      </a>
      <a href="/delete/${e.id}" style="position:absolute;left:100%;top:50%;transform:translateY(-50%);color:red;">🗑️</a>
    </div></li>`;
  });
  html += `</ul>`;
  html += pager(page);
  // 設定フォーム
  html += `<form action="/update-settings" method="post" style="margin-top:20px;">`;
  html += `<label><input type="checkbox" name="recruiting" value="off"${db.data.settings.recruiting?"":" checked"}> 募集を終了する</label><br>`;
  html += `理由:<br><textarea name="reason" style="width:300px;height:80px;">${db.data.settings.reason}</textarea><br>`;
  html += `フロントエンドタイトル:<br><textarea name="frontendTitle" style="width:300px;height:50px;">${db.data.settings.frontendTitle}</textarea><br>`;
  html += `管理者パスワード:<br><input type="text" name="adminPassword" style="width:300px;"><br>`;
  html += `<label><input type="checkbox" name="playerControlsEnabled"${db.data.settings.playerControlsEnabled?" checked":""}> 再生・音量ボタンを表示</label><br><br>`;
  html += `<button style="font-size:18px;padding:12px;">設定を更新</button>`;
  html += `</form>`;
  // Sync/Fetch
  html += `<div style="margin-top:20px;"><button onclick="location.href='/sync-requests'">GitHubに同期</button> `;
  html += `<button onclick="location.href='/fetch-requests'">GitHubから取得</button></div>`;
  html += `<br><a href="/">↵ 戻る</a>`;
  html += `</body></html>`;

  res.send(html);
});

app.post("/update-settings", (req, res) => {
  db.read();
  db.data.settings.recruiting             = !req.body.recruiting;
  db.data.settings.reason                = req.body.reason || "";
  db.data.settings.frontendTitle         = req.body.frontendTitle || db.data.settings.frontendTitle;
  if (req.body.adminPassword?.trim()) {
    db.data.settings.adminPassword       = req.body.adminPassword.trim();
  }
  db.data.settings.playerControlsEnabled  = !!req.body.playerControlsEnabled;
  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  // 即時反映に json 返却
  res.json({ success: true, settings: db.data.settings });
});

app.get("/settings", (req, res) => {
  res.json(db.data.settings);
});

// 20分ごと自動同期
cron.schedule("*/10 * * * *", async () => {
  console.log("自動更新ジョブ: GitHubへアップロード");
  try { await syncRequestsToGitHub(); console.log("完了"); }
  catch (e) { console.error("エラー:", e); }
});

app.listen(PORT, () => {
  console.log(`🚀 サーバ起動 http://localhost:${PORT}`);  
});
