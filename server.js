import express from "express";
import bodyParser from "body-parser";
import { LowSync, JSONFileSync } from "lowdb";
import { nanoid } from "nanoid";
import path from "path";
import fetch from "node-fetch";
import cron from "node-cron";
import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Render の Environment Variables を利用
const GITHUB_OWNER = process.env.GITHUB_OWNER; // 例: "housou0401"
const REPO_NAME = process.env.REPO_NAME;         // 例: "request-musicE"
const FILE_PATH = "db.json"; // リモート保存先ファイル
const BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;  // Personal Access Token

if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) {
  console.error("必要な環境変数が設定されていません。Render の Environment Variables を確認してください。");
  process.exit(1);
}

// データベース設定（lowdb用の db.json は responses などを含む）
const adapter = new JSONFileSync("db.json");
const db = new LowSync(adapter);
db.read();
db.data = db.data || { responses: [], lastSubmissions: {}, songCounts: {}, settings: {} };
// 初期化：settings に frontendTitle がない場合は追加
if (!db.data.lastSubmissions) db.data.lastSubmissions = {};
if (!db.data.songCounts) db.data.songCounts = {};
if (!db.data.settings) {
  db.data.settings = { recruiting: true, reason: "", frontendTitle: "♬曲をリクエストする" };
  db.write();
} else if (db.data.settings.frontendTitle === undefined) {
  db.data.settings.frontendTitle = "♬曲をリクエストする";
  db.write();
}

// 管理者パスワード
const ADMIN_PASSWORD = "housou0401";

// ミドルウェア
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// クライアントのIP取得（必要なら）
const getClientIP = (req) => {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown";
};

// 【Apple Music 検索（精度向上版）】
const fetchAppleMusicInfo = async (songTitle, artistName) => {
  try {
    const hasKorean  = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(songTitle);
    const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(songTitle);
    const hasEnglish  = /[A-Za-z]/.test(songTitle);
    let lang = "en_us"; // デフォルトはアメリカ英語
    if (hasKorean) {
      lang = "ko_kr";
    } else if (hasJapanese) {
      lang = "ja_jp";
    } else if (hasEnglish) {
      lang = "en_us";
    }
    
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
      let url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=JP&media=music&entity=song&limit=50&explicit=no&lang=${lang}`;
      let response = await fetch(url);
      let data = await response.json();
      if (data.results && data.results.length > 0) {
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
    console.error("❌ Apple Music 検索エラー:", error);
    return [];
  }
};

// 【/search エンドポイント】
app.get("/search", async (req, res) => {
  const query = req.query.query;
  if (!query || query.trim().length === 0) {
    return res.json([]);
  }
  const suggestions = await fetchAppleMusicInfo(query.trim(), "");
  res.json(suggestions);
});

// 【リクエスト送信処理】
app.post("/submit", async (req, res) => {
  const responseText = req.body.response?.trim();
  const artistText = req.body.artist?.trim() || "アーティスト不明";

  if (!responseText) {
    res.set("Content-Type", "text/html");
    return res.send(`<!DOCTYPE html>
<html lang='ja'><head><meta charset='UTF-8'></head>
<body><script>
alert('⚠️入力欄が空です。');
window.location.href='/';
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

  // db.json の responses 部分のみを { responses: [...] } 形式で保存
  const localContent = JSON.stringify({ responses: db.data.responses }, null, 2);
  fs.writeFileSync("db.json", localContent);

  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang='ja'><head><meta charset='UTF-8'></head>
<body><script>
alert('✅送信が完了しました！\\nリクエストありがとうございました！');
window.location.href='/';
</script></body></html>`);
});

// 【GitHub API を利用した同期関数】
// リモートの db.json を { "responses": [...] } の形式でアップロードする
async function syncRequestsToGitHub() {
  try {
    const localContent = JSON.stringify({ responses: db.data.responses }, null, 2);
    // GitHub 上の db.json を取得（存在しない場合は新規作成）
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
    if (sha) {
      putData.sha = sha;
    }
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

// 【/sync-requests エンドポイント】
// 管理者画面の「GitHubに同期」ボタンから呼び出し、リモートの db.json を更新する
app.get("/sync-requests", async (req, res) => {
  try {
    await syncRequestsToGitHub();
    res.send("✅ Sync 完了しました。<br><a href='/admin'>管理者ページに戻る</a>");
  } catch (e) {
    res.send("Sync エラー: " + (e.response ? JSON.stringify(e.response.data) : e.message));
  }
});

// 【/fetch-requests エンドポイント】
// GitHub 上の db.json を取得し、responses 部分をローカルの db.json に上書き保存する
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
    const fetchedData = JSON.parse(content);
    db.data.responses = fetchedData.responses || [];
    db.write();
    fs.writeFileSync("db.json", JSON.stringify({ responses: db.data.responses }, null, 2));
    res.send("✅ Fetch 完了しました。<br><a href='/admin'>管理者ページに戻る</a>");
  } catch (error) {
    console.error("❌ Fetch エラー:", error.response ? error.response.data : error.message);
    res.send("Fetch エラー: " + (error.response ? JSON.stringify(error.response.data) : error.message));
  }
});

// 【管理者ページ】
app.get("/admin", (req, res) => {
  let responseList = `<!DOCTYPE html>
<html lang='ja'>
<head>
  <meta charset='UTF-8'>
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
    /* 管理者用の設定フォーム内フィールド */
    .setting-field {
      margin-bottom: 10px;
    }
    /* 管理者用のボタン */
    .sync-btn, .fetch-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 14px;
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
    /* ボタンコンテナを左寄せ */
    .button-container {
      display: flex;
      justify-content: flex-start;
      margin-bottom: 10px;
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
  // 設定フォーム：募集状態、理由、さらにフロントエンドタイトルを更新
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
  <br>
  <button type="submit">設定を更新</button>
</form>`;
  // ボタンコンテナに Sync と Fetch ボタンを横並びに配置（左寄せ）
  responseList += `<div class="button-container">
    <button class="sync-btn" onclick="location.href='/sync-requests'">GitHubに同期</button>
    <button class="fetch-btn" onclick="location.href='/fetch-requests'">GitHubから取得</button>
  </div>`;
  // その下に戻るリンク
  responseList += `<br><a href='/'>↵戻る</a>`;
  responseList += `</body></html>`;
  res.set("Content-Type", "text/html");
  res.send(responseList);
});

// 【リクエスト削除機能】
app.get("/delete/:id", (req, res) => {
  const id = req.params.id;
  db.data.responses = db.data.responses.filter(entry => entry.id !== id);
  db.write();
  fs.writeFileSync("db.json", JSON.stringify({ responses: db.data.responses }, null, 2));
  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang='ja'><head><meta charset='UTF-8'></head>
<body><script>
alert('🗑️削除しました！');
window.location.href='/admin';
</script></body></html>`);
});

// 【管理者ログイン】
app.get("/admin-login", (req, res) => {
  const { password } = req.query;
  res.json({ success: password === ADMIN_PASSWORD });
});

// 【設定更新機能】
app.post("/update-settings", (req, res) => {
  db.data.settings.recruiting = req.body.recruiting ? false : true;
  db.data.settings.reason = req.body.reason || "";
  db.data.settings.frontendTitle = req.body.frontendTitle || "♬曲をリクエストする";
  db.write();
  res.redirect("/admin");
});

// 【設定取得機能（ユーザーページで利用）】
app.get("/settings", (req, res) => {
  res.json(db.data.settings);
});

// ---------- 自動更新ジョブ ----------
// 20分ごとに db.json の responses を GitHub にアップロードする
cron.schedule("*/20 * * * *", async () => {
  console.log("自動更新ジョブ開始: db.json の responses を GitHub にアップロードします。");
  try {
    await syncRequestsToGitHub();
    console.log("自動更新完了");
  } catch (e) {
    console.error("自動更新エラー:", e);
  }
});

// ---------- サーバー起動 ----------
app.listen(PORT, () => {
  console.log(`🚀サーバーが http://localhost:${PORT} で起動しました`);
});
