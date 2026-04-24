変更内容
- public/index.html の head 内 <style> を public/index.inline.css へ外出し
- public/index.html の末尾 inline <script> を public/index.inline.js へ外出し
- public/style.css と public/skript.js は内容を変更せず配置維持
- server.js の /register に既存ユーザー名の重複禁止チェックを追加
- index.inline.js に username_taken 用ポップアップ文言を追加
