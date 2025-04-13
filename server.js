import express from "express";
import bodyParser from "body-parser";
import { LowSync, JSONFileSync } from "lowdb";
import { nanoid } from "nanoid";
import fetch from "node-fetch";
import cron from "node-cron";
import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const FILE_PATH = "db.json";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_OWNER || !REPO_NAME || !GITHUB_TOKEN) {
  console.error("環境変数が不足しています。");
  process.exit(1);
}

const adapter = new JSONFileSync(path.join(__dirname, "db.json"));
const db = new LowSync(adapter);
db.read();
db.data ||= { responses: [], songCounts: {}, settings: {} };
if (!db.data.settings.playerControlsEnabled) db.data.settings.playerControlsEnabled = true;
if (!db.data.settings.recruiting) db.data.settings.recruiting = true;
if (!db.data.settings.frontendTitle) db.data.settings.frontendTitle = "♬曲をリクエストする";
if (!db.data.settings.adminPassword) db.data.settings.adminPassword = "housou0401";
db.write();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Apple Music 検索
async function fetchResults(q, entity="song", attr="") {
  let url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=JP&media=music&entity=${entity}&limit=50`;
  if (attr) url += `&attribute=${attr}`;
  const r = await fetch(url);
  return r.ok ? (await r.json()).results : [];
}
async function fetchArtistTracks(id) {
  const url = `https://itunes.apple.com/lookup?id=${id}&entity=song&country=JP&limit=50`;
  const r = await fetch(url);
  const d = await r.json();
  return d.results.slice(1).map(t=>({
    trackName:t.trackName, artistName:t.artistName,
    artworkUrl:t.artworkUrl100, trackViewUrl:t.trackViewUrl,
    previewUrl:t.previewUrl
  }));
}

app.get("/search", async (req,res) => {
  const mode=req.query.mode||"song";
  try {
    if (mode==="artist") {
      if (req.query.artistId) {
        return res.json(await fetchArtistTracks(req.query.artistId));
      }
      const list = await fetchResults(req.query.query,"album","artistTerm");
      const map = new Map();
      list.forEach(a=> map.set(a.artistId,{
        trackName:a.artistName, artistName:a.artistName,
        artworkUrl:a.artworkUrl100, artistId:a.artistId
      }));
      return res.json(Array.from(map.values()));
    } else {
      const list = await fetchResults(`${req.query.query} ${req.query.artist||""}`,"song","songTerm");
      return res.json(list.map(t=>({
        trackName:t.trackName, artistName:t.artistName,
        artworkUrl:t.artworkUrl100, trackViewUrl:t.trackViewUrl,
        previewUrl:t.previewUrl
      })));
    }
  } catch (e) {
    console.error(e);
    return res.json([]);
  }
});

app.post("/submit",(req,res)=>{
  const { response, artist, appleMusicUrl, artworkUrl, previewUrl } = req.body;
  if (!appleMusicUrl||!artworkUrl||!previewUrl) {
    return res.send(`<script>alert("必ず候補一覧から選択してください");location="/";</script>`);
  }
  if (!response.trim()) {
    return res.send(`<script>alert("入力が空です");location="/";</script>`);
  }
  const key = `${response}|${artist||"アーティスト不明"}`.toLowerCase();
  db.data.songCounts[key] = (db.data.songCounts[key]||0)+1;
  const exist = db.data.responses.find(r=>r.text===response&&r.artist===artist);
  if (exist) exist.count=db.data.songCounts[key];
  else db.data.responses.push({
    id:nanoid(), text:response, artist:artist||"アーティスト不明",
    appleMusicUrl, artworkUrl, previewUrl, count:db.data.songCounts[key]
  });
  db.write();
  fs.writeFileSync("db.json",JSON.stringify(db.data,null,2));
  res.send(`<script>alert("送信完了");location="/";</script>`);
});

app.get("/settings",(req,res)=>res.json(db.data.settings));
app.get("/admin-login",(req,res)=>res.json({success:req.query.password===db.data.settings.adminPassword}));

// GitHub sync/fetch
async function githubSync() {
  const content = Buffer.from(JSON.stringify(db.data,null,2)).toString("base64");
  let sha=null;
  try {
    const r = await axios.get(`https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`,{
      headers:{Authorization:`token ${GITHUB_TOKEN}`}
    });
    sha=r.data.sha;
  } catch(e){}
  const body={message:"sync",content,branch:BRANCH};
  if(sha) body.sha=sha;
  await axios.put(`https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,body,{
    headers:{Authorization:`token ${GITHUB_TOKEN}`}
  });
}
async function githubFetch() {
  const r=await axios.get(`https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`,{
    headers:{Authorization:`token ${GITHUB_TOKEN}`}
  });
  const data = JSON.parse(Buffer.from(r.data.content,"base64").toString("utf8"));
  db.data = data; db.write();
  fs.writeFileSync("db.json",JSON.stringify(data,null,2));
}

app.get("/sync-requests",async(req,res)=>{
  await githubSync();
  res.send(`<script>alert("Sync 完了");location="/admin";</script>`);
});
app.get("/fetch-requests",async(req,res)=>{
  await githubFetch();
  res.send(`<script>alert("Fetch 完了");location="/admin";</script>`);
});

cron.schedule("*/20 * * * *",async()=>{
  try{ await githubSync(); console.log("Auto sync"); }
  catch(e){console.error(e);}
});

app.get("/admin",(req,res)=>{
  const page=+req.query.page||1, per=10;
  const total=db.data.responses.length;
  const totalPages=Math.ceil(total/per);
  const start=(page-1)*per, end=start+per;
  const items=db.data.responses.slice(start,end);

  function pagLinks(){
    let h=`<div class="pagination">`;
    h+=`<a href="?page=1">«</a><a href="?page=${Math.max(1,page-1)}">‹</a>`;
    h+=`<span>${page}/${totalPages}</span>`;
    h+=`<a href="?page=${Math.min(totalPages,page+1)}">›</a><a href="?page=${totalPages}">»</a>`;
    h+=`</div>`;
    return h;
  }

  let html=`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>管理者ページ</title><link rel="stylesheet" href="/style.css"></head><body>`;
  html+=`<h1>管理者ページ</h1>${pagLinks()}<ul style="list-style:none;padding:0;">`;
  items.forEach(r=>{
    html+=`<li>
      <div class="entry-container">
        <div class="entry" onclick="window.open('${r.appleMusicUrl}','_blank')">
          <div class="count-badge">${r.count}</div>
          <img src="${r.artworkUrl}" alt="cover">
          <div><strong>${r.text}</strong><br><small>${r.artist}</small></div>
        </div>
        <a href="/delete/${r.id}" class="delete">🗑️</a>
      </div>
    </li>`;
  });
  html+=`</ul>${pagLinks()}
  <form action="/update-settings" method="post">
    <label><input type="checkbox" name="recruiting" ${db.data.settings.recruiting?"":"checked"}> 募集を終了</label><br>
    <textarea name="reason" placeholder="理由">${db.data.settings.reason||""}</textarea><br>
    <textarea name="frontendTitle" placeholder="タイトル">${db.data.settings.frontendTitle}</textarea><br>
    <input type="text" name="adminPassword" placeholder="管理者パスワード"><br>
    <label><input type="checkbox" name="playerControlsEnabled" ${db.data.settings.playerControlsEnabled?"checked":""}> プレビュー表示</label><br>
    <button type="submit">設定更新</button>
  </form>
  <button onclick="location.href='/sync-requests'">Sync GitHub</button>
  <button onclick="location.href='/fetch-requests'">Fetch GitHub</button>
  <br><br><a href="/">↵戻る</a>
  </body></html>`;
  res.send(html);
});

app.post("/update-settings",(req,res)=>{
  db.data.settings.recruiting = !req.body.recruiting;
  db.data.settings.reason = req.body.reason||"";
  db.data.settings.frontendTitle = req.body.frontendTitle||db.data.settings.frontendTitle;
  if (req.body.adminPassword) db.data.settings.adminPassword = req.body.adminPassword;
  db.data.settings.playerControlsEnabled = !!req.body.playerControlsEnabled;
  db.write();
  res.send(`<script>alert("設定更新");location="/admin";</script>`);
});

app.get("/delete/:id",(req,res)=>{
  db.data.responses = db.data.responses.filter(r=>r.id!==req.params.id);
  db.write();
  res.send(`<script>alert("削除完了");location="/admin";</script>`);
});

app.listen(PORT,()=>console.log(`Server running on http://localhost:${PORT}`));
