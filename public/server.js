import express from "express";
import bodyParser from "body-parser";
import { LowSync, JSONFileSync } from "lowdb";
import { nanoid } from "nanoid";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// LowDB 初期化
const adapter = new JSONFileSync(path.join(__dirname, "db.json"));
const db = new LowSync(adapter);
db.read();
db.data ||= {
  responses: [],
  lastSubmissions: {},
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

const ADMIN_PASSWORD = db.data.settings.adminPassword;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ルート
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Apple Music 検索
const fetchAppleMusic = async (term, artist="") => {
  const q = artist ? `${term} ${artist}` : term;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=JP&media=music&entity=song&limit=25`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    return data.results.map(t => ({
      trackName: t.trackName,
      artistName: t.artistName,
      artworkUrl: t.artworkUrl100,
      trackViewUrl: t.trackViewUrl,
      previewUrl: t.previewUrl
    }));
  } catch {
    return [];
  }
};

// /search
app.get("/search", async (req, res) => {
  const { mode, query, artistId, artist } = req.query;
  if (mode==="artist") {
    if (artistId) {
      const url = `https://itunes.apple.com/lookup?id=${artistId}&entity=song&limit=25`;
      const data = await (await fetch(url)).json();
      return res.json(data.results.slice(1).map(t=>({
        trackName:t.trackName, artistName:t.artistName,
        artworkUrl:t.artworkUrl100, trackViewUrl:t.trackViewUrl,
        previewUrl:t.previewUrl
      })));
    } else {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=JP&media=music&entity=musicArtist&limit=25`;
      const data = await (await fetch(url)).json();
      return res.json(data.results.map(a=>({
        artistId:a.artistId, trackName:a.artistName,
        artworkUrl:a.artworkUrl60
      })));
    }
  } else {
    const songs = await fetchAppleMusic(query, artist);
    res.json(songs);
  }
});

// /submit
app.post("/submit", (req,res) => {
  const song = req.body.response?.trim();
  const artist = req.body.artist?.trim()||"アーティスト不明";
  if (!song) return res.redirect("/");
  const key = `${song}|${artist}`;
  db.data.songCounts[key] = (db.data.songCounts[key]||0)+1;
  const existing = db.data.responses.find(r=>r.text===song&&r.artist===artist);
  if (existing) existing.count = db.data.songCounts[key];
  else db.data.responses.push({
    id: nanoid(), text:song, artist,
    appleMusicUrl:req.body.appleMusicUrl,
    artworkUrl:req.body.artworkUrl,
    previewUrl:req.body.previewUrl,
    count:1
  });
  db.write();
  res.send(`<script>alert('✅送信完了');location='/'</script>`);
});

// /settings
app.get("/settings", (req,res) => {
  res.json(db.data.settings);
});

// /admin-login
app.get("/admin-login", (req,res) => {
  res.json({ success: req.query.password===ADMIN_PASSWORD });
});

// /admin ページ（10件ずつページング）
app.get("/admin", (req,res) => {
  const page = Math.max(1, parseInt(req.query.page)||1);
  const pageSize = 10;
  const total = db.data.responses.length;
  const totalPages = Math.max(1, Math.ceil(total/pageSize));
  const start = (page-1)*pageSize;
  const slice = db.data.responses.slice(start, start+pageSize);

  const paginationHtml = () => {
    let html = `<div class="pagination">`;
    if (page>1) {
      html += `<a href="/admin?page=1">|<</a>`;
      html += `<a href="/admin?page=${page-1}"><</a>`;
    }
    html += `<span>${page}/${totalPages}</span>`;
    if (page<totalPages) {
      html += `<a href="/admin?page=${page+1}">></a>`;
      html += `<a href="/admin?page=${totalPages}">>|</a>`;
    }
    html += `</div>`;
    return html;
  };

  let html = `<!DOCTYPE html>
<html lang='ja'>
<head>
  <meta charset='UTF-8'>
  <title>管理者ページ</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1>✉アンケート回答一覧</h1>
  ${paginationHtml()}
  <ul>`;
  slice.forEach(r => {
    html += `<li>
      <div class="selected-item" style="display:inline-block; position:relative; margin-bottom:10px;">
        <span class="count-badge">${r.count}</span>
        <a href="${r.appleMusicUrl}" target="_blank" style="display:inline-flex;align-items:center;text-decoration:none; border:1px solid rgba(0,0,0,0.1); padding:10px; border-radius:10px;">
          <img src="${r.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
          <div><strong>${r.text}</strong><br><small>${r.artist}</small></div>
        </a>
        <a href="/delete/${r.id}" class="clear-btn" style="position:absolute; left:calc(100%+10px); top:50%; transform:translateY(-50%); color:red; text-decoration:none;">×</a>
      </div>
    </li>`;
  });
  html += `</ul>
  ${paginationHtml()}
  <form action="/update-settings" method="post" style="margin-top:20px;">
    <label><input type="checkbox" name="recruiting" ${!db.data.settings.recruiting?"checked":""}> 募集を終了する</label><br>
    <textarea name="reason" placeholder="理由" style="width:300px; height:80px; margin-top:10px;">${db.data.settings.reason}</textarea><br>
    <textarea name="frontendTitle" placeholder="フロントエンドタイトル" style="width:300px; height:40px; margin-top:10px;">${db.data.settings.frontendTitle}</textarea><br>
    <input type="text" name="adminPassword" placeholder="管理者パスワード" value="${db.data.settings.adminPassword}" style="width:300px; margin-top:10px;"><br>
    <label style="display:block; margin-top:10px;">
      <input type="checkbox" name="playerControlsEnabled" ${db.data.settings.playerControlsEnabled?"checked":""}> プレビュー再生を有効にする
    </label><br>
    <button type="submit" style="margin-top:10px;">設定を更新</button>
  </form>
  <a href='/' style="display:inline-block; margin-top:20px;">↵戻る</a>
</body>
</html>`;

  res.send(html);
});

// /update-settings
app.post("/update-settings", (req,res) => {
  const s = db.data.settings;
  s.recruiting = !req.body.recruiting;
  s.reason = req.body.reason||"";
  s.frontendTitle = req.body.frontendTitle||s.frontendTitle;
  s.adminPassword = req.body.adminPassword||s.adminPassword;
  s.playerControlsEnabled = !!req.body.playerControlsEnabled;
  db.write();
  res.send(`<script>alert('✅設定を更新しました');setTimeout(()=>location='/admin',500);</script>`);
});

// /delete
app.get("/delete/:id", (req,res) => {
  db.data.responses = db.data.responses.filter(r=>r.id!==req.params.id);
  db.write();
  res.send(`<script>alert('🗑️削除しました');location='/admin';</script>`);
});

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
