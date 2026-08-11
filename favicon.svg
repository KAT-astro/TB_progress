# TB_progress GitHub同期Worker

GitHub Pages上の公開アプリから、秘密情報を公開せずにprivateリポジトリへ学習データを保存する無料のCloudflare Workerです。

## 1. GitHub OAuth Appを作る

GitHubの **Settings → Developer settings → OAuth Apps → New OAuth App** で作成します。

- Application name: `TB_progress`
- Homepage URL: `https://kat-astro.github.io/TB_progress/`
- Authorization callback URL: `https://あなたのworker.workers.dev/auth/callback`

Callback URLはWorkerのURLが決まった後、完全一致で登録してください。

## 2. Workerをデプロイする

Cloudflareの無料アカウントでログインし、このフォルダから実行します。

```bash
npm install
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put PUBLIC_URL
npm run deploy
```

`PUBLIC_URL`にはデプロイ先のWorker URLを入れます。最初のデプロイでURLが決まる場合は、いったんデプロイしてURLを確認し、GitHub OAuth AppのCallback URLと`PUBLIC_URL`を設定してもう一度デプロイしてください。

`wrangler.toml`の`APP_ORIGIN`、`GITHUB_DATA_REPO`、`GITHUB_DATA_PATH`は、今の設定（`kat-astro.github.io`、`TB_progress_data`、`study-data.json`）のまま使えます。

## 3. GitHub PagesアプリにWorker URLを入力する

GitHub Pages版を開き、画面上部の「GitHubに自動同期」にWorker URLを入力して「GitHubで接続」を押します。接続後は、最初に「GitHubから読み込む」または「GitHubへ保存」を選び、必要なら「変更時に自動同期」をオンにします。

WorkerはGitHub OAuthのClient Secretとアクセストークンを公開アプリへ埋め込みません。GitHub APIにはprivateリポジトリ用の`repo`権限で接続し、データは`TB_progress_data/study-data.json`へ保存します。
