const express = require("express");
const bodyParser = require("body-parser");
const { LowSync, JSONFileSync } = require("lowdb");
const { nanoid } = require("nanoid");
const path = require("path");

const app = express();
const PORT = 3000;

// データベース設定（JSONファイルを使用）
const adapter = new JSONFileSync("db.json");
const db = new LowSync(adapter);
db.read();
// db.json にデータが存在しない場合、初期値をセット
db.data = db.data || { responses: [], lastSubmissions: {} };
// もし db.data が存在しても lastSubmissions プロパティがなければ初期化
if (!db.data.lastSubmissions) {
    db.data.lastSubmissions = {};
}

// 管理者パスワード（ここを変更してください）
const ADMIN_PASSWORD = "housou0401";

// ミドルウェア設定
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// クライアントのIPアドレスを取得する関数
const getClientIP = (req) => {
    return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown";
};

// フロントページ（アンケート入力ページ）
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// アンケート送信処理（スパム対策あり）
// ※ 備考欄の入力も受け付け、データに含めます
app.post("/submit", (req, res) => {
    const responseText = req.body.response?.trim();
    const remarkText = req.body.remark ? req.body.remark.trim() : "";
    const clientIP = getClientIP(req);
    const currentTime = Date.now();

    if (!responseText) {
        return res.status(400).send("空のリクエストは送信できません。");
    }

    // スパム対策（10秒以内の連続送信をブロック）
    const lastSubmission = db.data.lastSubmissions[clientIP];
    if (lastSubmission && lastSubmission.text === responseText && currentTime - lastSubmission.time < 10000) {
        return res.status(429).send("<script>alert('短時間で同じリクエストを送信できません'); window.location='/';</script>");
    }

    // データを保存（備考欄も含む）
    const newEntry = { id: nanoid(), text: responseText, remark: remarkText };
    db.data.responses.push(newEntry);
    db.data.lastSubmissions[clientIP] = { text: responseText, time: currentTime };
    db.write();

    // 送信完了後、トップページにリダイレクト
    res.send("<script>alert('送信が完了しました！'); window.location='/';</script>");
});

// 管理者ログイン処理（パスワード認証）
app.get("/admin-login", (req, res) => {
    const { password } = req.query;
    res.json({ success: password === ADMIN_PASSWORD });
});

// 管理者用ページ（一覧表示）
// 備考欄は回答の下の行に、小さなフォントで左揃え（一文字分の空白をあける）で表示します
app.get("/admin", (req, res) => {
    let responseList = "<h1>アンケート回答一覧</h1><ul>";
    db.data.responses.forEach(entry => {
        responseList += `<li>${entry.text} <a href="/delete/${entry.id}" style="color:red;">[削除する]</a>`;
        if (entry.remark) {
            responseList += `<br><span style="font-size: 0.8em; display: block; text-align: left; margin-left: 1em;">${entry.remark}</span>`;
        }
        responseList += `</li>`;
    });
    responseList += "</ul><a href='/'>戻る</a>";
    res.send(responseList);
});

// アンケート回答削除処理
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
