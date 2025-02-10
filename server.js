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
db.data = db.data || { responses: [], lastSubmissions: {} };
if (!db.data.lastSubmissions) {
    db.data.lastSubmissions = {};
}

// 管理者パスワード
const ADMIN_PASSWORD = "housou0401";

// ミドルウェア
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// クライアントのIP取得
const getClientIP = (req) => {
    return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown";
};

// フロントページ
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// iTunes Search API で曲の URL を取得する関数（日本語対応 & 完全一致）
const fetchAppleMusicLink = async (songTitle, artistName) => {
    try {
        const query = encodeURIComponent(`${songTitle} ${artistName}`);
        const url = `https://itunes.apple.com/search?term=${query}&country=JP&media=music&limit=10&lang=ja_jp`;
        const response = await fetch(url);
        const data = await response.json();

        // 曲名とアーティスト名が完全一致するものを探す
        const exactMatch = data.results.find(track => 
            track.trackName === songTitle && track.artistName === artistName
        );

        return exactMatch ? exactMatch.trackViewUrl : null;
    } catch (error) {
        console.error("❌ Apple Music 検索エラー:", error);
        return null;
    }
};

// リクエスト送信処理
app.post("/submit", (req, res) => {
    const responseText = req.body.response?.trim();
    const artistText = req.body.artist?.trim();  // アーティスト名として受け取る
    const clientIP = getClientIP(req);
    const currentTime = Date.now();

    if (!responseText || !artistText) {
        return res.status(400).send("⚠️曲名とアーティスト名を入力してください。");
    }

    // スパム対策
    const lastSubmission = db.data.lastSubmissions[clientIP];
    if (lastSubmission && lastSubmission.text === responseText && lastSubmission.artist === artistText && currentTime - lastSubmission.time < 10000) {
        return res.status(429).send("<script>alert('⚠️短時間で同じリクエストを送信できません'); window.location='/';</script>");
    }

    // データ保存
    const newEntry = { id: nanoid(), text: responseText, artist: artistText, appleMusicUrl: null };
    db.data.responses.push(newEntry);
    db.data.lastSubmissions[clientIP] = { text: responseText, artist: artistText, time: currentTime };
    db.write();

    res.send("<script>alert('✅送信が完了しました！'); window.location='/';</script>");
});

// 管理者ログイン
app.get("/admin-login", (req, res) => {
    const { password } = req.query;
    res.json({ success: password === ADMIN_PASSWORD });
});

// 管理者ページ (Apple Music のリンク追加)
app.get("/admin", async (req, res) => {
    let responseList = "<h1>✉アンケート回答一覧</h1><ul>";

    for (let entry of db.data.responses) {
        let appleMusicUrl = entry.appleMusicUrl;

        // Apple Music URL が未取得なら取得
        if (!appleMusicUrl) {
            appleMusicUrl = await fetchAppleMusicLink(entry.text, entry.artist);
            entry.appleMusicUrl = appleMusicUrl || "🔍検索不可";
            db.write();
        }

        responseList += `<li>
            ${entry.text} - ${entry.artist}  
            ${appleMusicUrl !== "🔍検索不可" ? `<a href="${appleMusicUrl}" target="_blank" style="color:blue;">[🎵 Apple Music]</a>` : "🔍検索不可"}
            <a href="/delete/${entry.id}" style="color:red;">[削除]</a>
        </li>`;
    }

    responseList += "</ul><a href='/'>↵戻る</a>";
    res.send(responseList);
});

// 回答削除
app.get("/delete/:id", (req, res) => {
    const id = req.params.id;
    db.data.responses = db.data.responses.filter(entry => entry.id !== id);
    db.write();
    res.redirect("/admin");
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`🚀サーバーが http://localhost:${PORT} で起動しました`);
});
