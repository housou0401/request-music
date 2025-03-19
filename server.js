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

// Render の Environment Variables（Environment タブで設定）
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const FILE_PATH = "db.json";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) {
  console.error("必要な環境変数(GITHUB_OWNER, REPO_NAME, GITHUB_TOKEN)が設定されていません。");
  process.exit(1);
}

// LowDB のセットアップ
const adapter = new JSONFileSync("db.json");
const db = new LowSync(adapter);
db.read();
db.data = db.data || { responses: [], songCounts: {}, settings: {} };
if (!db.data.songCounts) db.data.songCounts = {};
if (!db.data.settings) {
  db.data.settings = {
    recruiting: true,
    reason: "",
    frontendTitle: "♬曲をリクエストする",
    adminPassword: "housou0401",
    playerControlsEnabled: true
  };
  db.write();
} else {
  if (db.data.settings.playerControlsEnabled === undefined) {
    db.data.settings.playerControlsEnabled = true;
  }
  db.write();
}

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

/* Apple Music 検索関連 */
async function fetchResultsForQuery(query, lang, entity = "song", attribute = "") {
  let url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=JP&media=music&entity=${entity}&limit=50&explicit=no&lang=${lang}`;
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
  const url = `https://itunes.apple.com/lookup?id=${artistId}&entity=song&country=JP&limit=50`;
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

/* /search エンドポイント */
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

app.get("/sync-reque
