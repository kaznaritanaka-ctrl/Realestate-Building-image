# Realestate-Building-image

土地の情報から建築イメージを3案生成するサービス「土地の未来図｜AI建築イメージ生成」。全体設計は Issue #1 を参照。

## site/（公開準備中の静的サイト）

`https://realestate.ai-investment-research.net/` に配置する、ビルド不要の静的サイト。ASP（アフィリエイト）審査用のサイトURL登録を兼ねる。

- `index.html` — サービス概要・利用イメージ・サンプル・開発状況・注意事項・運営者情報
- `privacy.html` — プライバシーポリシー
- `ad-policy.html` — 広告掲載方針
- `assets/` — CSS、サンプル概形イメージ（SVG。生成例ができたら差し替え）
- `_headers` — Cloudflare Pages 用のセキュリティヘッダ（JavaScriptなし前提のCSP）

### デプロイ（Cloudflare Workers Static Assets）

既存の ai-investment-* と同じく Workers で運用する。設定は `wrangler.jsonc`（Worker名 `realestate-site`、カスタムドメイン `realestate.ai-investment-research.net` を宣言済み）。

1. Cloudflare ダッシュボード → Workers & Pages → 作成 → 「リポジトリをインポート」→ このリポジトリ
2. ビルドコマンド：なし ／ デプロイコマンド：`npx wrangler deploy`（既定のまま）
3. 以後 `main` への push で自動デプロイ
4. 投資系とは別 Worker・別シークレットで運用する


