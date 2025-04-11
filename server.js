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

const app = express(), PORT = process.env.PORT||3000;
const adapter = new JSONFileSync("db.json");
const db = new LowSync(adapter);
db.read();
db.data ||= { responses:[], songCounts:{}, settings:{} };
if (!db.data.settings.playerControlsEnabled) db.data.settings.playerControlsEnabled = true;
db.write();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// (検索ロジックは省略。先ほどのfetchAppleMusicInfo等をここに配置)

app.get("/search", /* as before */);

app.post("/submit", /* as before */);

app.get("/settings",(req,res)=>res.json(db.data.settings));

app.get("/admin-login",(req,res)=>res.json({success: req.query.password===db.data.settings.adminPassword}));

app.get("/admin",(req,res)=>{
  const page=parseInt(req.query.page||"1",10);
  const per=10, total=db.data.responses.length;
  const totalPages=Math.ceil(total/per);
  const start=(page-1)*per, end=start+per;
  const items=db.data.responses.slice(start,end);

  const pagination = (cur,tot)=>{
    let h=`<div class="pagination">`;
    h+=`<a href="?page=1">«</a>`;
    h+=`<a href="?page=${Math.max(1,cur-1)}">‹</a>`;
    h+=`<span>${cur}/${tot}</span>`;
    h+=`<a href="?page=${Math.min(tot,cur+1)}">›</a>`;
    h+=`<a href="?page=${tot}">»</a>`;
    h+=`</div>`;
    return h;
  };

  let html=`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>管理者ページ</title><link rel="stylesheet" href="/style.css"></head><body>`;
  html+=`<h1>✉アンケート回答一覧</h1>`;
  html+=pagination(page,totalPages);
  html+=`<ul style="list-style:none;padding:0;">`;
  items.forEach(e=>{
    html+=`<li><div class="entry-container">
      <a href="${e.appleMusicUrl||'#'}" target="_blank" class="entry">
        <div class="count-badge">${e.count}</div>
        <img src="${e.artworkUrl}" alt="Cover">
        <div><strong>${e.text}</strong><br><small>${e.artist}</small></div>
      </a>
      <a href="/delete/${e.id}" class="delete">🗑️</a>
    </div></li>`;
  });
  html+=`</ul>`;
  html+=pagination(page,totalPages);
  // 設定フォーム、Sync/Fetch ボタン etc.（省略。前回版を流用）
  html+=`</body></html>`;
  res.send(html);
});

app.get("/delete/:id",(req,res)=>{
  db.data.responses = db.data.responses.filter(r=>r.id!==req.params.id);
  db.write();
  res.redirect("/admin");
});

// /update-settings, /sync-requests, /fetch-requests, cron などは先ほどのまま

app.listen(PORT,()=>console.log(`🚀 http://localhost:${PORT}`));
