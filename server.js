import express from "express";
import bodyParser from "body-parser";
import { LowSync, JSONFileSync } from "lowdb";
import { nanoid } from "nanoid";
import fetch from "node-fetch";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// DB 初期化
const adapter = new JSONFileSync("db.json");
const db = new LowSync(adapter);
db.read();
db.data = db.data || {
  responses: [],
  songCounts: {},
  settings: {
    recruiting: true,
    reason: "",
    frontendTitle: "♬曲をリクエストする",
    adminPassword: "housou0401",
    playerControlsEnabled: true
  }
};
db.write();

// 管理者パスワード
const ADMIN_PASSWORD = db.data.settings.adminPassword;

// ミドルウェア
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Apple Music 検索
async function fetchAppleMusicInfo(songTitle, artistName) {
  const lang = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(songTitle)
    ? "ko_kr"
    : /[\u3040-\u30FF\u4E00-\u9FFF]/.test(songTitle)
    ? "ja_jp"
    : /[A-Za-z]/.test(songTitle)
    ? "en_us"
    : "en_us";
  const queries = artistName
    ? [`"${songTitle}" ${artistName}`, `${songTitle} ${artistName}`, songTitle]
    : [`"${songTitle}"`, `${songTitle} official`, songTitle];

  for (const q of queries) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
      q
    )}&country=JP&media=music&entity=song&limit=20&explicit=no&lang=${lang}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.results && data.results.length) {
        const seen = new Set();
        return data.results
          .filter((t) => {
            const key = (t.trackName + "|" + t.artistName).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((t) => ({
            trackName: t.trackName,
            artistName: t.artistName,
            trackViewUrl: t.trackViewUrl,
            artworkUrl: t.artworkUrl100,
            previewUrl: t.previewUrl
          }));
      }
    } catch (e) {
      console.error("iTunes API エラー:", e);
    }
  }
  return [];
}

// /search
app.get("/search", async (req, res) => {
  const { mode, query, artist, artistId } = req.query;
  if (mode === "artist") {
    if (artistId) {
      // アーティストのトップ曲取得
      const results = await fetchAppleMusicInfo("", "");
      // ここでは簡易に全曲からフィルタ（本来はアーティストIDで検索）
      res.json(results.filter((t) => t.artistId === artistId));
    } else {
      // アーティスト検索（曲名フィールドにアーティスト名を渡す）
      const results = await fetchAppleMusicInfo(query, "");
      // 一旦曲名として返し、UI 側でアーティスト名表示
      res.json(results);
    }
  } else {
    // 曲検索
    const results = await fetchAppleMusicInfo(query, artist || "");
    res.json(results);
  }
});

// /submit
app.post("/submit", (req, res) => {
  const { response: text, artist, appleMusicUrl, artworkUrl, previewUrl } = req.body;
  if (!text || !appleMusicUrl) {
    return res.send(`<script>alert("必ず候補から選択してください");window.location.href="/";</script>`);
  }
  const key = `${text}|${artist}`.toLowerCase();
  db.data.songCounts[key] = (db.data.songCounts[key] || 0) + 1;
  const existing = db.data.responses.find((r) => r.text === text && r.artist === artist);
  if (existing) {
    existing.count = db.data.songCounts[key];
  } else {
    db.data.responses.push({
      id: nanoid(),
      text,
      artist,
      appleMusicUrl,
      artworkUrl,
      previewUrl,
      count: db.data.songCounts[key]
    });
  }
  db.write();
  res.send(`<script>alert("✅ リクエスト完了");window.location.href="/";</script>`);
});

// /settings
app.get("/settings", (req, res) => {
  res.json(db.data.settings);
});
app.post("/update-settings", (req, res) => {
  const { recruiting, reason, frontendTitle, adminPassword, playerControlsEnabled } = req.body;
  db.data.settings.recruiting = recruiting !== undefined;
  db.data.settings.reason = reason;
  db.data.settings.frontendTitle = frontendTitle;
  db.data.settings.adminPassword = adminPassword;
  db.data.settings.playerControlsEnabled = playerControlsEnabled !== undefined;
  db.write();
  res.send(`<script>alert("✅ 設定を更新しました");window.location.href="/admin";</script>`);
});

// /admin
app.get("/admin", (req, res) => {
  let html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>管理者</title>
  <link rel="stylesheet" href="/style.css">
  </head><body><h1>管理者ページ</h1>
  <ul>`;
  db.data.responses.forEach((e) => {
    html += `<li>
      <span class="count-badge">${e.count}</span>
      <a href="${e.appleMusicUrl}" target="_blank">${e.text}／${e.artist}</a>
      <a href="/delete/${e.id}" class="delete">削除</a>
    </li>`;
  });
  html += `</ul>
    <form action="/update-settings" method="post">
      <label>募集中<input type="checkbox" name="recruiting" ${db.data.settings.recruiting?"checked":""}></label><br>
      <label>フロントタイトル<br><input type="text" name="frontendTitle" value="${db.data.settings.frontendTitle}"></label><br>
      <label>管理者パスワード<br><input type="text" name="adminPassword" value="${db.data.settings.adminPassword}"></label><br>
      <label>音楽プレビュー表示<input type="checkbox" name="playerControlsEnabled" ${db.data.settings.playerControlsEnabled?"checked":""}></label><br>
      <label>理由<br><textarea name="reason">${db.data.settings.reason}</textarea></label><br>
      <button type="submit">設定を更新</button>
    </form>
    <a href="/">戻る</a>
  </body></html>`;
  res.send(html);
});

// /delete
app.get("/delete/:id", (req, res) => {
  db.data.responses = db.data.responses.filter((e) => e.id !== req.params.id);
  db.write();
  res.redirect("/admin");
});

// /admin-login
app.get("/admin-login", (req, res) => {
  res.json({ success: req.query.password === db.data.settings.adminPassword });
});

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
