# 楽天デイリーランキング

楽天ウェブサービスのランキングAPIから、ジャンル別ランキングを毎日取得して GitHub Pages に公開する静的サイトです。
GAS・スプレッドシート・外部サーバーは不要で、すべて無料の範囲で動きます。

## 仕組み

```
GitHub Actions (毎日 05:30 JST)
  → scripts/build.mjs が楽天ランキングAPIを取得
  → data/ に当日の順位・価格を保存(前日比の計算に使用)
  → dist/ に静的HTMLを生成して GitHub Pages に公開
```

## 初回セットアップ

1. **Secrets を登録**
   Settings → Secrets and variables → Actions → New repository secret
   - `RAKUTEN_APP_ID` … 楽天ウェブサービスのアプリID(applicationId)
   - `RAKUTEN_ACCESS_KEY` … アクセスキー(accessKey)
2. **Pages を有効化**
   Settings → Pages → Build and deployment → Source を **GitHub Actions** にする
3. **初回実行**
   Actions タブ → "Update ranking and deploy" → Run workflow
4. 数分後、`https://nokes21.github.io/rakuten-ranking/` に公開されます

楽天ウェブサービス側のアプリ設定では、「WebサイトURL(許可されたWebサイト)」に
`https://nokes21.github.io/` を登録してください(2026年の仕様変更で必須です)。

## 設定ファイル

- `config/site.json` … サイト名、公開URL、アフィリエイトID、表示件数(topN)
- `config/genres.json` … 対象ジャンル(`enabled` で表示のON/OFF)

## ローカルでの動作確認

```bash
MOCK=1 node scripts/build.mjs   # ダミーデータで dist/ を生成
```

## 注意

- 商品画像・情報の表示は、楽天ウェブサービスの利用規約に従ってください。
- ページ上部のPR表記とフッターのクレジット表記は削除しないでください。
