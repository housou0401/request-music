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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 省略: /search, /submit, /settings, /admin-login 同上

// 管理者ページ（ページング対応）
app.get("/admin", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 10;
  const total = db.data.responses.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const slice = db.data.responses.slice(start, start + pageSize);

  const paginationHtml = () => {
    let h = `<div class="pagination">`;
    if (page > 1) {
      h += `<a href="/admin?page=1">|<</a>`;
      h += `<a href="/admin?page=${page - 1}"><</a>`;
    }
    h += `<span>${page}/${totalPages}</span>`;
    if (page < totalPages) {
      h += `<a href="/admin?page=${page + 1}">></a>`;
      h += `<a href="/admin?page=${totalPages}">>|</a>`;
    }
    h += `</div>`;
    return h;
  };

  let html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>管理者ページ</title>
<link rel="stylesheet" href="/style.css"></head><body>
<h1>✉アンケート回答一覧</h1>
${paginationHtml()}
<ul>`;
  slice.forEach(r => {
    html += `<li>
      <div class="selected-item" style="display:inline-block; position:relative; margin-bottom:10px;">
        <span class="count-badge">${r.count}</span>
        <a href="${r.appleMusicUrl}" target="_blank" style="display:inline-flex;align-items:center;text-decoration:none; border:1px solid rgba(0,0,0,0.1); padding:10px; border-radius:10px;">
          <img src="${r.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px">
          <div><strong>${r.text}</strong><br><small>${r.artist}</small></div>
        </a>
        <a href="/delete/${r.id}" class="clear-btn" style="position:absolute; left:calc(100%+10px); top:50%; transform:translateY(-50%); color:red; text-decoration:none;">×</a>
      </div>
    </li>`;
  });
  html += `</ul>
${paginationHtml()}
<!-- 設定フォーム 以下省略 -->
</body></html>`;
  res.send(html);
});

// /update-settings, /delete も同様に…

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
