# べんきょう帳（GitHub Pages版）

`KAT-astro/TB_progress` に置いてGitHub Pagesで公開するための静的版です。

## 含まれている機能

- 参考書の複数登録
- 参考書ごとの複数ページ区間・区間名・リンク
- 学習日、開始ページ、終了ページ、学習区間名、メモの記録
- ページの重複学習を色分けした連続ページマップ
- 参考書ごと・全参考書の進捗率
- 読了目標日
- 初期状態では閉じている学習カレンダー
- 学習記録と参考書の削除確認

## GitHub Pagesへの置き方

このフォルダの中身を`TB_progress`リポジトリのルートにアップロードしてください。

1. `TB_progress`の **Settings → Pages** を開く
2. **Source** を **GitHub Actions** にする
3. `master`（または`main`）へファイルをアップロードする
4. Actionsの`Deploy to GitHub Pages`が完了するまで待つ

## データについて

通常はブラウザの`localStorage`に保存します。さらに、同梱の`github-sync-worker`を無料のCloudflare Workerとしてデプロイすると、画面上部からGitHub OAuthで接続し、privateリポジトリ`KAT-astro/TB_progress_data`の`study-data.json`へ保存できます。

同期を使う場合の手順は[`github-sync-worker/README.md`](github-sync-worker/README.md)にあります。GitHubのClient Secretやアクセストークンは公開Pages側に置きません。
