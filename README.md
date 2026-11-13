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

## 各ジャンルページの内容

今日の注目商品 / 急上昇 / 新着ランクイン / 値下がり / ジャンルの傾向 / TOP30(前日比・7日推移・連続ランクイン日数つき)。
変動系の情報は、前日以前のデータが溜まった2日目以降に表示されます。
API取得に失敗したジャンルは、前回データを「○/○時点」と明記して表示し、変動情報は出しません。

## 公開後にやること(SEO)

1. [Google Search Console](https://search.google.com/search-console/) にサイトを登録する(URLプレフィックスで `https://nokes21.github.io/rakuten-ranking/`)。
2. 所有権確認で「HTMLタグ」を選び、表示された `content="..."` の値を `config/site.json` の `googleSiteVerification` に設定する。
3. サイトマップ `sitemap.xml` を送信する(送信しても全ページが登録されるとは限りません)。
4. 数週間後、表示回数・クリック数・検索キーワードを見て、タイトルや掲載ジャンルを調整する。

## 公開前に確認すること(規約)

- 楽天ウェブサービスの利用規約: 取得データの保存・再利用・加工の範囲、更新頻度の要件、クレジット表記
- 楽天アフィリエイトの規約: サイト(メディア)の登録、商品画像・リンクの利用条件、PR表記

履歴(`data/`)には、順位・価格・商品コードのみを保存しています(商品名・画像URLなどは含みません)。

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
