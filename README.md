# Realestate-Building-image

土地の情報から建築イメージを3案生成するサービス「土地の未来図｜AI建築イメージ生成」。全体設計は Issue #1 を参照。

## site/（公開準備中の静的サイト）

`https://realestate.ai-investment-research.net/` に配置する、静的アセット＋TypeScriptで構築したWebアプリ。`src/app.ts` や `src/report.ts` を変更したときは **`npm run build` で `site/assets/app.js` を再生成する必要がある**。

- `index.html` — サービス概要・利用イメージ・サンプル・開発状況・注意事項・運営者情報
- `privacy.html` — プライバシーポリシー
- `ad-policy.html` — 広告掲載方針
- `assets/` — CSS、サンプル概形イメージ（SVG。生成例ができたら差し替え）
- `_headers` — Cloudflare Pages 用のセキュリティヘッダ（JavaScriptなし前提のCSP）

### デプロイ（Cloudflare Workers Static Assets）

既存の ai-investment-* と同じく Workers で運用する。設定は `wrangler.jsonc`（Worker名 `realestate-site`、カスタムドメイン `realestate.ai-investment-research.net` を宣言済み）。

1. Cloudflare ダッシュボード → Workers & Pages → 作成 → 「リポジトリをインポート」→ このリポジトリ
2. **Cloudflare Workers Buildsのビルドコマンドに `npm run build` を設定**し、デプロイコマンドを `npx wrangler deploy` にする。Workers Buildsは `wrangler.jsonc` のカスタムbuild設定を参照しないので、ダッシュボード側に明示的な設定が必要。ローカルでの `npx wrangler deploy` は `wrangler.jsonc` の `build.command` が実行される。
3. 以後 `main` への push で自動デプロイ
4. 投資系とは別 Worker・別シークレットで運用する



## 土地調査レポート（A4横3ページ）

土地概要＋建築イメージA/B/C、法規制の参考情報、災害・地形情報を固定3ページに印刷できます。取得対象・データ制約・印刷検証は [docs/report-sources.md](docs/report-sources.md) を参照。`npm test` はエンジン・レポート・公的データレイヤーの単体テストを実行します。
