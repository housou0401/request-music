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
db.data = db.data || { responses: [], lastSubmissions: {}, songCounts: {}, settings: {} };
if (!db.data.lastSubmissions) db.data.lastSubmissions = {};
if (!db.data.songCounts) db.data.songCounts = {};
if (!db.data.settings) {
    db.data.settings = { recruiting: true, reason: "" };
    db.write();
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

// **Apple Music 検索（精度向上版）**
// ① 完全一致検索 → ② 曲名のみ検索 → ③ 人気順検索 の順に試行
const fetchAppleMusicInfo = async (songTitle, artistName) => {
    try {
        let queries = [
            `${songTitle} ${artistName}`, // 完全一致検索
            `${songTitle}`,               // 曲名のみ検索
            `${songTitle}&sort=popularity` // 人気順検索
        ];
        for (let query of queries) {
            let url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=JP&media=music&entity=song&limit=10&explicit=no&lang=ja_jp`;
            let response = await fetch(url);
            let data = await response.json();
            if (data.results.length > 0) {
                // 最大10件の候補を返す
                return data.results.map(track => ({
                    trackName: track.trackName,
                    artistName: track.artistName,
                    trackViewUrl: track.trackViewUrl,
                    artworkUrl: track.artworkUrl100
                }));
            }
        }
        return [];
    } catch (error) {
        console.error("❌ Apple Music 検索エラー:", error);
        return [];
    }
};

// **/search エンドポイント**
// 曲名入力に基づいて、近似の曲候補を返す（最大10件）
app.get("/search", async (req, res) => {
    const query = req.query.query;
    if (!query || query.trim().length === 0) {
        return res.json([]);
    }
    const suggestions = await fetchAppleMusicInfo(query.trim(), "");
    res.json(suggestions);
});

// **リクエスト送信処理**
// フロントエンドから送信された曲名およびアーティスト名でリクエストを登録する
app.post("/submit", async (req, res) => {
    // ここでは、ユーザーページ側で選択された曲情報が各入力欄にセットされる前提
    const responseText = req.body.response?.trim(); // ※必要に応じて送信前に自動設定される処理を追加できますが、ここでは入力内容を利用
    const artistText = req.body.artist?.trim() || "アーティスト不明";
    const clientIP = getClientIP(req);
    const currentTime = Date.now();

    if (!responseText) {
        res.set("Content-Type", "text/html");
        return res.send(`<!DOCTYPE html>
<html lang='ja'><head><meta charset='UTF-8'></head>
<body><script>
alert('⚠️入力欄が空です。');
window.location.href='/';
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
            appleMusicUrl: "", // ここはフロントエンドで選択された場合にセットするか、または改めてAPI検索してもよい\n      count: 1
        });
    }

    db.write();
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html>
<html lang='ja'><head><meta charset='UTF-8'></head>
<body><script>
alert('✅送信が完了しました！\\nリクエストありがとうございました！');
window.location.href='/';
</script></body></html>`);
});

// **管理者ページ（リクエスト一覧＆設定フォーム追加）**
app.get("/admin", (req, res) => {
    let responseList = `<!DOCTYPE html>
<html lang='ja'>
<head>
  <meta charset='UTF-8'>
  <title>管理者ページ</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; }
    ul { list-style: none; padding: 0; }
    li { margin-bottom: 10px; }
    a { text-decoration: none; }
    a.delete { color: red; margin-left: 10px; }
    a.apple { color: blue; margin-left: 10px; }
    h1 { font-size: 1.5em; }
    form { margin: 20px 0; text-align: left; }\n    textarea { width: 300px; height: 80px; font-size: 0.9em; color: black; display: block; margin-bottom: 10px; }\n  </style>\n</head>\n<body>\n`;
    responseList += `<h1>✉アンケート回答一覧</h1><ul>`;
    for (let entry of db.data.responses) {
        responseList += `<li>
      [${entry.count}件] ${entry.text} - ${entry.artist || "🎤アーティスト不明"}
      ${entry.appleMusicUrl !== "" ? `<a href="${entry.appleMusicUrl}" target="_blank" class="apple">[🎵 Apple Music]</a>` : "🔍検索不可"}
      <a href="/delete/${entry.id}" class="delete">[削除]</a>
    </li>`;
    }
    responseList += `</ul>`;
    // 設定フォーム（募集状態・理由）の追加
    responseList += `<form action="/update-settings" method="post">
  <label style="display: block; margin-bottom: 10px;">\n    <input type="checkbox" name="recruiting" value="off" ${db.data.settings.recruiting ? "" : "checked"} style="transform: scale(1.5); vertical-align: middle; margin-right: 10px;">\n    募集を終了する\n  </label>\n  <label style="display: block; margin-bottom: 10px;">理由:</label>\n  <textarea name="reason" placeholder="理由（任意）" style="width:300px; height:80px; font-size:0.9em; color:black;">${db.data.settings.reason || ""}</textarea>\n  <br>\n  <button type="submit">設定を更新</button>\n</form>`;
    responseList += `<a href='/'>↵戻る</a>
</body>
</html>`;
    res.set("Content-Type", "text/html");
    res.send(responseList);
});

// **リクエスト削除機能**
app.get("/delete/:id", (req, res) => {
    const id = req.params.id;
    db.data.responses = db.data.responses.filter(entry => entry.id !== id);
    db.write();
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html>
<html lang='ja'><head><meta charset='UTF-8'></head>
<body><script>
alert('🗑️削除しました！');
window.location.href='/admin';
</script></body></html>`);
});

// **管理者ログイン**
app.get("/admin-login", (req, res) => {
    const { password } = req.query;
    res.json({ success: password === ADMIN_PASSWORD });
});

// **設定更新機能**
app.post("/update-settings", (req, res) => {
    // チェックボックスが送信されれば募集終了（recruiting を false）、送信されなければ募集中（true）
    db.data.settings.recruiting = req.body.recruiting ? false : true;
    db.data.settings.reason = req.body.reason || "";
    db.write();
    res.redirect("/admin");
});

// **設定取得機能（ユーザーページで利用）**
app.get("/settings", (req, res) => {
    res.json(db.data.settings);
});

// **サーバー起動**
app.listen(PORT, () => {
    console.log(`🚀サーバーが http://localhost:${PORT} で起動しました`);
});