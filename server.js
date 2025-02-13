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

// db.json の初期構造
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
    adminPassword: "housou0401",
    maintenance: false,
    startDate: "",
    endDate: "",
    instagram: false
  };
  db.write();
} else {
  if (db.data.settings.frontendTitle === undefined) {
    db.data.settings.frontendTitle = "♬曲をリクエストする";
  }
  if (db.data.settings.adminPassword === undefined) {
    db.data.settings.adminPassword = "housou0401";
  }
  if (db.data.settings.maintenance === undefined) {
    db.data.settings.maintenance = false;
  }
  if (db.data.settings.startDate === undefined) {
    db.data.settings.startDate = "";
  }
  if (db.data.settings.endDate === undefined) {
    db.data.settings.endDate = "";
  }
  if (db.data.settings.instagram === undefined) {
    db.data.settings.instagram = false;
  }
  db.write();
}

// ミドルウェア
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// クライアントのIP取得（必要なら）
const getClientIP = (req) => {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown";
};

// 【Apple Music 検索】
const fetchAppleMusicInfo = async (songTitle, artistName) => {
  try {
    const hasKorean  = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(songTitle);
    const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(songTitle);
    const hasEnglish  = /[A-Za-z]/.test(songTitle);
    let lang = "en_us";
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
  if (!query || query.trim().length === 0) return res.json([]);
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
  // 保存時は db.data 全体を JSON 形式で保存
  const localContent = JSON.stringify(db.data, null, 2);
  fs.writeFileSync("db.json", localContent);
  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body><script>
alert("✅送信が完了しました！\\nリクエストありがとうございました！");
window.location.href="/";
</script></body></html>`);
});

// 【GitHub API を利用した同期関数】
// db.json 全体をそのままアップロードする
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
// 管理者画面の「GitHubに同期」ボタン押下時、同期完了後に管理者画面へ自動リダイレクト（3秒後）
app.get("/sync-requests", async (req, res) => {
  try {
    await syncRequestsToGitHub();
    res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head>
<body>
<p style="font-size:18px; color:green;">✅ Sync 完了しました。</p>
</body></html>`);
  } catch (e) {
    res.send("Sync エラー: " + (e.response ? JSON.stringify(e.response.data) : e.message));
  }
});

// 【/fetch-requests エンドポイント】
// GitHub 上の db.json を取得し、ローカルの db.data に上書き保存、完了後に管理者画面へ自動リダイレクト（3秒後）
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
<p style="font-size:18px; color:green;">✅ Fetch 完了しました。</p>
</body></html>`);
  } catch (error) {
    console.error("❌ Fetch エラー:", error.response ? error.response.data : error.message);
    res.send("Fetch エラー: " + (error.response ? JSON.stringify(error.response.data) : error.message));
  }
});

// 【/reset-db エンドポイント】
// db.json の responses 部分（その他設定はそのまま）をリセット（空にする）
app.get("/reset-db", (req, res) => {
  db.data.responses = [];
  db.write();
  fs.writeFileSync("db.json", JSON.stringify(db.data, null, 2));
  res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head>
<body>
<p style="font-size:18px; color:green;">✅ db.json をリセットしました。</p>
</body></html>`);
});

// 【管理者ログイン】
app.get("/admin-login", (req, res) => {
  const { password } = req.query;
  res.json({ success: password === db.data.settings.adminPassword });
});

// 【設定更新機能】
app.post("/update-settings", (req, res) => {
  db.data.settings.recruiting = req.body.recruiting ? false : true;
  db.data.settings.reason = req.body.reason || "";
  db.data.settings.frontendTitle = req.body.frontendTitle || "♬曲をリクエストする";
  if (req.body.adminPassword && req.body.adminPassword.trim().length > 0) {
    db.data.settings.adminPassword = req.body.adminPassword.trim();
  }
  // 新たに、メンテナンス、開始日時、終了日時、Instagramの設定を更新
  db.data.settings.maintenance = req.body.maintenance === "on" ? true : false;
  db.data.settings.startDate = req.body.startDate || "";
  db.data.settings.endDate = req.body.endDate || "";
  db.data.settings.instagram = req.body.instagram === "on" ? true : false;
  db.write();
  res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/admin"></head>
<body>
<p style="font-size:18px; color:green;">設定を完了しました。</p>
</body></html>`);
});

// 【設定取得機能（ユーザーフォーム用）】
app.get("/settings", (req, res) => {
  res.json(db.data.settings);
});

// ---------- 自動更新ジョブ ----------
// 20分ごとに db.json 全体を GitHub にアップロードする
cron.schedule("*/20 * * * *", async () => {
  console.log("自動更新ジョブ開始: db.json を GitHub にアップロードします。");
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
