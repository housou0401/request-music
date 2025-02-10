const express = require("express");
const bodyParser = require("body-parser");
const { LowSync, JSONFileSync } = require("lowdb");
const { nanoid } = require("nanoid");
const path = require("path");

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

// リクエスト送信処理
app.post("/submit", (req, res) => {
    const responseText = req.body.response?.trim();
    const remarkText = req.body.remark ? req.body.remark.trim() : "";
    const clientIP = getClientIP(req);
    const currentTime = Date.now();

    if (!responseText) {
        return res.status(400).send("空のリクエストは送信できません。");
    }

    // スパム対策
    const lastSubmission = db.data.lastSubmissions[clientIP];
    if (lastSubmission && lastSubmission.text === responseText && currentTime - lastSubmission.time < 10000) {
        return res.status(429).send("<script>alert('短時間で同じリクエストを送信できません'); window.location='/';</script>");
    }

    // データ保存
    const newEntry = { id: nanoid(), text: responseText, remark: remarkText };
    db.data.responses.push(newEntry);
    db.data.lastSubmissions[clientIP] = { text: responseText, time: currentTime };
    db.write();

    res.send("<script>alert('送信が完了しました！'); window.location='/';</script>");
});

// 管理者ログイン
app.get("/admin-login", (req, res) => {
    const { password } = req.query;
    res.json({ success: password === ADMIN_PASSWORD });
});

// 管理者ページ
app.get("/admin", (req, res) => {
    let responseList = "<h1>アンケート回答一覧</h1><ul>";
    db.data.responses.forEach(entry => {
        responseList += `<li>${entry.text} <a href="/delete/${entry.id}" style="color:red;">[削除]</a>`;
        if (entry.remark) {
            responseList += `<br><span style="font-size: 0.8em; margin-left: 1em;">${entry.remark}</span>`;
        }
        responseList += "</li>";
    });
    responseList += "</ul><a href='/'>戻る</a>";
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
    console.log(`サーバーが http://localhost:${PORT} で起動しました`);
});
