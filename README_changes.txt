主な修正点（スマートフォン重視）

1. プレビュー再生の整理
- AudioManager の最終段を一本化し、load/play/pause を安定化
- 曲選択時の自動再生で、メディア準備完了(canplay / loadedmetadata)を待ってから再生
- 端末側の最初のユーザー操作で音声再生をアンロック
- 再生終了時の自動次送りを停止し、ボタン表示だけ戻す
- 既存の複数の hotfix が競合していた状態を、末尾の stabilizer で上書き整理

2. カードスワイプの改善
- スマホではブラウザ標準の横スクロール + 慣性スクロールを優先
- 独自 pointer drag に依存しない native scroll ベースへ寄せた
- スクロール中の3D更新を requestAnimationFrame で間引き
- スクロール停止後に最近傍カードへスナップ
- スクロールバー非表示、touch-action / overscroll をスマホ向けに調整

3. 変更ファイル
- public/skript.js
- public/style.css

補足
- 見た目・デザインは大きく変えていません
- 既存機能を壊しにくいよう、末尾に安定化レイヤーを追加する形で修正しています
