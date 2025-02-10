import express from "express";
import bodyParser from "body-parser";
import { LowSync, JSONFileSync } from "lowdb";
import { nanoid } from "nanoid";
import path from "path";
import fetch from "node-fetch";

const app = express();
const PORT = 3000;

// データベース設定
const adapter = new JSONFileSync("db.json");
const db = new LowSync(adapter);
db.read();
db.data = db.data || { responses: [], lastSubmissions: {}, songCounts: {} };
if (!db.data.lastSubmissions) db.data.lastSubmissions = {};
if (!db.data.songCounts) db.data.songCounts = {};

// 管理者パスワード
const ADMIN_PASSWORD = "housou0401";

// ミドルウェア
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// クライアントのIP取得
const getClientIP = (req) => {
    return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown";
};

// **iTunes Search API で正式な曲名 & アーティスト名を取得**
const fetchAppleMusicInfo = async (songTitle, artistName) => {
    try {
        let query = encodeURIComponent(`${songTitle} ${artistName}`.trim());
        let url = `https://itunes.apple.com/search?term=${query}&country=JP&media=music&limit=1&lang=ja_jp`;
        let response = await fetch(url);
        let data = await response.json();

        if (data.results.length > 0) {
            const track = data.results[0];
            return {
                trackName: track.trackName, // Apple Music の正式な曲名
                artistName: track.artistName, // Apple Music の正式なアーティスト名
                trackViewUrl: track.trackViewUrl // Apple Music のリンク
            };
        }
        return null;
    } catch (error) {
        console.error("❌ Apple Music 検索エラー:", error);
        return null;
    }
};

// **リクエスト送信処理**
app.post("/submit", async (req, res) => {
    const responseText = req.body.response?.trim();
    let artistText = req.body.artist?.trim() || "アーティスト不明"; // 未入力なら「アーティスト不明」
    const clientIP = getClientIP(req);
    const currentTime = Date.now();

    if (!responseText) {
        return res.status(400).send("⚠️曲名を入力してください。");
    }

    // **Apple Music で正式な表記を取得**
    let appleMusicData = await fetchAppleMusicInfo(responseText, artistText === "アーティスト不明" ? "" : artistText);
    const finalSongTitle = appleMusicData ? appleMusicData.trackName : responseText;
    const finalArtistName = appleMusicData ? appleMusicData.artistName : artistText;

    // **曲のリクエスト回数を記録**
    const key = `${finalSongTitle.toLowerCase()}|${finalArtistName.toLowerCase()}`;
    db.data.songCounts[key] = (db.data.songCounts[key] || 0) + 1;

    // **データ保存（重複リクエストはまとめる）**
    const existingEntry = db.data.responses.find(entry => entry.text.toLowerCase() === finalSongTitle.toLowerCase() && entry.artist.toLowerCase() === finalArtistName.toLowerCase());

    if (existingEntry) {
        existingEntry.count = db.data.songCounts[key]; // リクエスト回数更新
    } else {
        db.data.responses.push({
            id: nanoid(),
            text: finalSongTitle,
            artist: finalArtistName,
            appleMusicUrl: appleMusicData ? appleMusicData.trackViewUrl : "🔍検索不可",
            count: db.data.songCounts[key]
        });
    }

    db.data.lastSubmissions[clientIP] = { text: finalSongTitle, artist: finalArtistName, time: currentTime };
    db.write();

    res.send("<script>alert('✅送信が完了しました！'); window.location='/';</script>");
});

// **管理者ログイン**
app.get("/admin-login", (req, res) => {
    const { password } = req.query;
    res.json({ success: password === ADMIN_PASSWORD });
});

// **管理者ページ (リクエスト一覧を統合 & Apple Music のリンク追加)**
app.get("/admin", async (req, res) => {
    let responseList = `<h1 style="font-size: 1.5em;">✉アンケート回答一覧</h1><ul style="font-size: 1.2em;">`;

    for (let entry of db.data.responses) {
        responseList += `<li>
            【${entry.count}件】 ${entry.text} - ${entry.artist || "🎤アーティスト不明"}  
            ${entry.appleMusicUrl !== "🔍検索不可" ? `<a href="${entry.appleMusicUrl}" target="_blank" style="color:blue;">[🎵 Apple Music]</a>` : "🔍検索不可"}
            <a href="/delete/${entry.id}" style="color:red;">[削除]</a>
        </li>`;
    }

    responseList += "</ul><a href='/'>↵戻る</a>";
    res.send(responseList);
});

// **回答削除**
app.get("/delete/:id", (req, res) => {
    const id = req.params.id;
    db.data.responses = db.data.responses.filter(entry => entry.id !== id);
    db.write();
    res.redirect("/admin");
});

// **サーバー起動**
app.listen(PORT, () => {
    console.log(`🚀サーバーが http://localhost:${PORT} で起動しました`);
});
