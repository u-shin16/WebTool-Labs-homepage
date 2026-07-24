# WebTool-Labs homepage

WebTool-Labsと公開中のWebアプリを紹介する静的サイトです。

## ローカル起動

```bash
npm run dev
```

`http://127.0.0.1:8000/` を開いて確認します。存在しないURLでは `404.html` をHTTP 404で表示します。

npmを使わない場合は `node scripts/serve.mjs` でも起動できます。

## 検証

```bash
npm test
npm run check:html
npm run check:links
npm run check:links:external
```

一括検証は `node scripts/validate-site.mjs` でも実行できます。

- `npm test`: title、description、canonical、OGP、構造化データ、画像属性、内部リンク、sitemapを一括確認
- `npm run check:html`: HTMLとメタ情報の確認
- `npm run check:links`: ローカルリンクとページ内アンカーの確認
- `npm run check:links:external`: 外部URLのHTTP応答も確認（ネットワーク環境が必要。Node.jsの通信が失敗した場合は `curl` で再確認）

## 本番反映

このリポジトリには自動デプロイ設定が含まれていません。現在の本番サーバーが `main` ブランチを取得する運用であることを管理者が確認したうえで、通常は次の順で反映します。

```bash
git add .
git commit -m "Improve content quality and site trust"
git push origin main
```

本番サーバーで手動更新している場合は、サーバー上でデプロイ用ユーザーに切り替え、既存の公開手順に従ってください。nginxへセキュリティヘッダーを適用する場合は、`deploy/nginx-security-headers.conf` を対象の `server` ブロックから読み込み、次を実行します。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

本番反映後は、トップページ、6つのアプリ紹介、信頼性ページ、存在しないURL、`robots.txt`、`sitemap.xml`、`ads.txt` を再確認してください。
