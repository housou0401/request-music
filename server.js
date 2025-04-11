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

const app = express(), PORT=process.env.PORT||3000;
const adapter=new JSONFileSync("db.json"), db=new LowSync(adapter);
db.read(); db.data ||= { responses:[], songCounts:{}, settings:{} };
if(!db.data.settings.frontendTitle) db.data.settings={ recruiting:true, reason:"", frontendTitle:"♬曲をリクエストする", adminPassword:"housou0401", playerControlsEnabled:true };

app.use(bodyParser.urlencoded({ extended:true }));
app.use(express.static("public"));

// iTunes API ヘルパー（省略…fetchAppleMusicInfo, fetchArtistTracks）

app.get("/search", async (req,res)=>{
  // same logic as previous
});

// submit, settings, admin-login も previous と同じ

// 管理者ページ
app.get("/admin", (req,res)=>{
  const page=parseInt(req.query.page)||1, per=10;
  const total=db.data.responses.length, totalPages=Math.ceil(total/per);
  const slice=db.data.responses.slice((page-1)*per, page*per);

  const makeLinks=()=>{
    let h=`<div class="pagination">`;
    h+=`<a href="?page=1">«</a><a href="?page=${Math.max(1,page-1)}">‹</a>`;
    for(let p=1;p<=totalPages;p++){
      h+= p===page?`<span>${p}</span>`:`<a href="?page=${p}">${p}</a>`;
    }
    h+=`<a href="?page=${Math.min(totalPages,page+1)}">›</a><a href="?page=${totalPages}">»</a>`;
    h+=`</div>`;
    return h;
  };

  let html=`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>管理者ページ</title><link rel="stylesheet" href="/style.css"><style>
  .entry-box{ border:1px solid rgba(0,0,0,0.1);border-radius:10px;padding:10px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between; }
  .entry-box img{ width:50px;height:50px;border-radius:5px;margin-right:10px; }
  .entry-content{ display:flex;align-items:center; }
  .delete-btn{ color:red; font-size:20px; text-decoration:none; margin-left:10px; }
  </style></head><body>
  <h1>✉アンケート回答一覧</h1>
  <form action="/update-settings" method="post" style="margin-bottom:20px;">
    <label><input type="checkbox" name="recruiting" ${db.data.settings.recruiting?"":"checked"}> 募集を終了する</label><br>
    <label>タイトル:<input type="text" name="frontendTitle" value="${db.data.settings.frontendTitle}" style="width:300px;margin:5px 0;"></label><br>
    <label>プレビュー再生:<input type="checkbox" name="playerControlsEnabled" ${db.data.settings.playerControlsEnabled?"checked":""}></label><br>
    <label>理由:<textarea name="reason" style="width:300px;height:60px;">${db.data.settings.reason}</textarea></label><br>
    <label>管理者PW:<input type="text" name="adminPassword" placeholder="新パスワード" style="width:300px;"></label><br>
    <button type="submit">設定を更新</button>
  </form>
  ${makeLinks()}
  <ul style="list-style:none;padding:0;">`;
  slice.forEach(r=>{
    html+=`<li>
      <div class="entry-box">
        <div class="entry-content">
          <span class="count-badge">${r.count}</span>
          <a href="${r.appleMusicUrl}" target="_blank" style="display:flex;align-items:center;text-decoration:none;color:inherit;">
            <img src="${r.artworkUrl}">
            <div><strong>${r.text}</strong><br><small>${r.artist}</small></div>
          </a>
        </div>
        <a href="/delete/${r.id}" class="delete-btn">🗑️</a>
      </div>
    </li>`;
  });
  html+=`</ul>${makeLinks()}
  <button onclick="location.href='/sync-requests'" style="margin-right:10px;">GitHubに同期</button>
  <button onclick="location.href='/fetch-requests'">GitHubから取得</button>
  <br><br><a href="/" style="text-decoration:none;font-size:18px;">↵戻る</a>
  </body></html>`;
  res.send(html);
});

// その他 /submit,/settings,/admin-login,/delete,/sync-requests,/fetch-requests,cron も prior と同じ

app.listen(PORT, ()=>console.log(`🚀 http://localhost:${PORT}`));
