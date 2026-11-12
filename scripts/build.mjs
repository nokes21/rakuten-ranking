// 楽天ランキングAPIを取得し、履歴を保存して、静的サイト(dist/)を生成する。
// 依存パッケージなし (Node 20+)。
//
// 環境変数:
//   RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY ... 楽天ウェブサービスの認証情報(GitHub Secrets)
//   MOCK=1                               ... APIを呼ばずダミーデータで生成(動作確認用)
//   BUILD_DATE=YYYY-MM-DD                ... 日付を上書き(動作確認用)

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DATA = path.join(ROOT, 'data');
const ENDPOINT = 'https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601';

const site = JSON.parse(await readFile(path.join(ROOT, 'config/site.json'), 'utf8'));
const allGenres = JSON.parse(await readFile(path.join(ROOT, 'config/genres.json'), 'utf8'));
const genres = allGenres.filter((g) => g.enabled);

const MOCK = process.env.MOCK === '1';
const APP_ID = process.env.RAKUTEN_APP_ID;
const ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID || site.affiliateId;

const jst = (d = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(d); // "2026-11-12 06:10"
const TODAY = process.env.BUILD_DATE || jst().slice(0, 10);
const NOW_LABEL = jst().replace(/-/g, '/');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- API取得

function normalize(raw) {
  const it = raw.Item ?? raw; // formatVersion 1/2 の両対応
  const firstImage = (v) => {
    if (!Array.isArray(v) || v.length === 0) return '';
    const x = v[0];
    return typeof x === 'string' ? x : x?.imageUrl ?? '';
  };
  return {
    rank: Number(it.rank),
    code: String(it.itemCode ?? ''),
    name: String(it.itemName ?? '').trim(),
    price: Number(it.itemPrice ?? 0),
    url: String(it.itemUrl ?? ''),
    aff: String(it.affiliateUrl ?? ''),
    img: firstImage(it.mediumImageUrls),
    review: Number(it.reviewAverage ?? 0),
    reviewCount: Number(it.reviewCount ?? 0),
    shop: String(it.shopName ?? ''),
    freeShipping: Number(it.postageFlag) === 0,
    pointRate: Number(it.pointRate ?? 1),
  };
}

async function callApi(genre, withPeriod) {
  const params = new URLSearchParams({
    applicationId: APP_ID,
    accessKey: ACCESS_KEY,
    affiliateId: AFFILIATE_ID,
    genreId: String(genre.genreId),
    formatVersion: '2',
    page: '1',
  });
  if (withPeriod) params.set('period', 'realtime');
  const origin = site.allowedOrigin;
  return fetch(`${ENDPOINT}?${params}`, {
    headers: { Referer: `${origin}/`, Origin: origin, 'User-Agent': 'rakuten-ranking-site' },
  });
}

async function fetchRanking(genre) {
  let withPeriod = true;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await callApi(genre, withPeriod);
    if (res.ok) {
      const json = await res.json();
      const items = (json.Items ?? json.items ?? []).map(normalize)
        .filter((i) => i.code && i.name && i.rank > 0);
      return items.slice(0, site.topN);
    }
    const body = (await res.text()).slice(0, 300);
    if (res.status === 400 && withPeriod) {
      console.warn(`[${genre.slug}] 400 → period指定なしで再試行: ${body}`);
      withPeriod = false;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = 2000 * attempt;
      console.warn(`[${genre.slug}] HTTP ${res.status} → ${wait}ms待って再試行`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  throw new Error('リトライ上限');
}

// 動作確認用のダミーデータ
function mockRanking(genre) {
  const seed = [...TODAY].reduce((a, c) => a + c.charCodeAt(0), 0);
  const order = Array.from({ length: site.topN }, (_, i) => i + 1);
  // 日付ごとに順位をシャッフルして順位変動を再現
  order.sort((a, b) => ((a * 7919 + seed * genre.genreId) % 101) - ((b * 7919 + seed * genre.genreId) % 101));
  return order.map((n, idx) => ({
    rank: idx + 1,
    code: `mock-${genre.slug}:${n}`,
    name: `【サンプル】${genre.name}の人気商品 ${n} 送料無料 ポイント5倍 テスト用ダミー商品名です`,
    price: 1000 + n * 137 + ((seed + n) % 5) * 50,
    url: `https://item.rakuten.co.jp/example/${n}/`,
    aff: `https://hb.afl.rakuten.co.jp/ichiba/${AFFILIATE_ID}/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fexample%2F${n}%2F`,
    img: '',
    review: 3.5 + ((n * 13) % 15) / 10,
    reviewCount: 10 + n * 37,
    shop: `サンプルショップ${n}`,
    freeShipping: n % 3 !== 0,
    pointRate: 1,
  }));
}

// ---------------------------------------------------------------- 履歴

async function loadHistoryDates() {
  const dir = path.join(DATA, 'history');
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10)).sort();
}

async function loadHistory(date) {
  return JSON.parse(await readFile(path.join(DATA, 'history', `${date}.json`), 'utf8'));
}

// ---------------------------------------------------------------- HTML

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const bigImg = (u) => (u ? u.replace(/_ex=\d+x\d+/, '_ex=200x200') : '');

function layout({ title, description, canonical, depth, body, jsonLd }) {
  const root = depth === 0 ? './' : '../'.repeat(depth);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<link rel="stylesheet" href="${root}style.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<div class="pr-bar">【PR】当サイトは楽天アフィリエイトを利用しています。リンク経由でのご購入により、運営者に報酬が発生する場合があります。</div>
<header class="header"><div class="wrap">
  <a class="logo" href="${root}">${esc(site.name)}</a>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="footer"><div class="wrap">
  <p>順位・価格・在庫は取得時点(${esc(NOW_LABEL)} 更新)の情報です。最新の情報は必ず楽天市場の商品ページでご確認ください。</p>
  <p><a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener">Supported by Rakuten Developers</a></p>
</div></footer>
</body>
</html>
`;
}

function nav(current) {
  const prefix = current === null ? '' : '../';
  const chip = (g) =>
    `<a class="chip${g.slug === current ? ' on' : ''}" href="${prefix}${g.slug}/">${esc(g.name)}</a>`;
  if (current === null) {
    const groups = [...new Set(genres.map((g) => g.group))];
    return groups.map((gr) =>
      `<div class="grp"><span class="grp-name">${esc(gr)}</span><nav class="chips">${
        genres.filter((g) => g.group === gr).map(chip).join('')}</nav></div>`).join('');
  }
  const cur = genres.find((g) => g.slug === current);
  return `<nav class="chips"><a class="chip" href="../">すべてのジャンル</a>${
    genres.filter((g) => g.group === cur.group).map(chip).join('')}</nav>`;
}

function deltaBadge(it) {
  if (it.isNew) return '<span class="delta new">NEW</span>';
  if (it.delta > 0) return `<span class="delta up">▲${it.delta}</span>`;
  if (it.delta < 0) return `<span class="delta down">▼${-it.delta}</span>`;
  return it.hasPrev ? '<span class="delta flat">→</span>' : '';
}

function priceNote(it) {
  if (!it.priceDiff) return '';
  const cls = it.priceDiff < 0 ? 'cut' : 'rise';
  const sign = it.priceDiff < 0 ? '↓' : '↑';
  return `<span class="pdiff ${cls}">前日比 ${sign}${yen(Math.abs(it.priceDiff))}</span>`;
}

function card(it, { showRank = true } = {}) {
  const href = it.aff || it.url;
  const img = bigImg(it.img);
  const stars = it.reviewCount > 0
    ? `<span class="review">★${it.review.toFixed(2)} <small>(${it.reviewCount.toLocaleString('ja-JP')}件)</small></span>` : '';
  return `<li class="item${showRank ? '' : ' norank'}">
  ${showRank ? `<div class="rank r${Math.min(it.rank, 4)}"><b>${it.rank}</b>位${deltaBadge(it)}</div>` : ''}
  <a class="thumb" href="${esc(href)}" target="_blank" rel="nofollow sponsored noopener">${img ? `<img src="${esc(img)}" alt="" loading="lazy" width="120" height="120">` : '<span class="noimg">No Image</span>'}</a>
  <div class="info">
    <a class="name" href="${esc(href)}" target="_blank" rel="nofollow sponsored noopener">${esc(clip(it.name, 70))}</a>
    <div class="price">${yen(it.price)}${priceNote(it)}</div>
    <div class="meta">${stars}${it.freeShipping ? '<span class="tag">送料無料</span>' : ''}${it.pointRate > 1 ? `<span class="tag">ポイント${it.pointRate}倍</span>` : ''}<span class="shop">${esc(it.shop)}</span></div>
    <a class="btn" href="${esc(href)}" target="_blank" rel="nofollow sponsored noopener">楽天市場で見る</a>
  </div>
</li>`;
}

const CSS = `
:root{--bg:#f6f6f4;--fg:#222;--sub:#666;--line:#e3e3df;--card:#fff;--red:#bf0000;--up:#d4380d;--down:#1d6fb8;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",Meiryo,sans-serif}
a{color:inherit}.wrap{max-width:860px;margin:0 auto;padding:0 16px}
.pr-bar{background:#fff7e0;border-bottom:1px solid #f0e0a8;font-size:12px;padding:6px 16px;text-align:center;color:#6b5a1a}
.header{background:var(--red);color:#fff}.header .wrap{padding:12px 16px}.logo{font-weight:700;font-size:18px;text-decoration:none}
h1{font-size:22px;margin:24px 0 4px}h2{font-size:17px;margin:32px 0 10px;border-left:4px solid var(--red);padding-left:10px}
.lead{color:var(--sub);margin:0 0 16px;font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.chip{background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:13px;text-decoration:none}.chip.on{background:var(--red);color:#fff;border-color:var(--red)}
.grp{margin:8px 0}.grp-name{font-size:12px;color:var(--sub);font-weight:600}.grp .chips{margin:4px 0 8px}
.list{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.item{display:grid;grid-template-columns:56px 120px 1fr;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;align-items:start}
.item.norank{grid-template-columns:120px 1fr}
.rank{text-align:center;font-size:12px;color:var(--sub)}.rank b{display:block;font-size:24px;line-height:1.1;color:var(--fg)}
.rank.r1 b{color:#c9a100}.rank.r2 b{color:#8a8f98}.rank.r3 b{color:#b06a2c}
.delta{display:block;font-size:11px;font-weight:700;margin-top:2px}.delta.up{color:var(--up)}.delta.down{color:var(--down)}.delta.flat{color:#aaa}.delta.new{color:#fff;background:var(--red);border-radius:4px;padding:0 4px;display:inline-block}
.thumb{display:block;width:120px;height:120px;background:#fafafa;border-radius:6px;overflow:hidden}.thumb img{width:100%;height:100%;object-fit:contain}.noimg{display:grid;place-items:center;height:100%;color:#bbb;font-size:12px}
.name{font-weight:600;text-decoration:none;display:block;margin-bottom:4px}.name:hover{text-decoration:underline}
.price{font-size:18px;font-weight:700;color:var(--red)}.pdiff{font-size:12px;font-weight:400;margin-left:8px}.pdiff.cut{color:var(--down)}.pdiff.rise{color:var(--up)}
.meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:12px;color:var(--sub);margin:4px 0 8px}.review{color:#e08a00;font-weight:600}.review small{color:var(--sub);font-weight:400}
.tag{border:1px solid #f0b4b4;color:var(--red);border-radius:4px;padding:0 5px}
.btn{display:inline-block;background:var(--red);color:#fff;text-decoration:none;border-radius:6px;padding:6px 16px;font-size:13px;font-weight:600}
.top5{display:grid;gap:8px;margin:0 0 8px;padding:0;list-style:none}.top5 li{background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px 12px;display:flex;gap:10px;align-items:baseline}.top5 b{min-width:2em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}.panel{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}.panel h3{margin:0 0 6px;font-size:15px}.panel a.more{font-size:12px}
.panel ol{margin:0;padding-left:1.4em;font-size:13px}.panel li{margin:2px 0}
.footer{margin-top:40px;border-top:1px solid var(--line);padding:16px 0 40px;font-size:12px;color:var(--sub)}
@media(max-width:560px){.item{grid-template-columns:44px 88px 1fr;gap:8px;padding:10px}.item.norank{grid-template-columns:88px 1fr}.thumb{width:88px;height:88px}.price{font-size:16px}}
`;

// ---------------------------------------------------------------- メイン

async function main() {
  if (!MOCK && (!APP_ID || !ACCESS_KEY)) {
    throw new Error('RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY が未設定です (テスト時は MOCK=1)');
  }

  const dates = await loadHistoryDates();
  const prevDate = [...dates].reverse().find((d) => d < TODAY);
  const prevHistory = prevDate ? await loadHistory(prevDate) : null;
  if (prevDate) console.log(`前日比の比較対象: ${prevDate}`);

  await mkdir(path.join(DATA, 'latest'), { recursive: true });
  await mkdir(path.join(DATA, 'history'), { recursive: true });

  const result = {}; // slug -> items
  let okCount = 0;

  for (const [i, g] of genres.entries()) {
    let items = null;
    try {
      items = MOCK ? mockRanking(g) : await fetchRanking(g);
      if (items.length < 3) throw new Error(`取得件数が少なすぎます(${items.length}件)`);
      okCount++;
      console.log(`✓ ${g.name}: ${items.length}件`);
    } catch (e) {
      console.error(`✗ ${g.name}: ${e.message}`);
      const fallback = path.join(DATA, 'latest', `${g.slug}.json`);
      if (existsSync(fallback)) {
        items = JSON.parse(await readFile(fallback, 'utf8')).items;
        console.warn(`  → 前回のデータを使用します`);
      }
    }
    if (items) result[g.slug] = items;
    if (!MOCK && i < genres.length - 1) await sleep(1200); // APIへの負荷配慮(1秒に1回程度)
  }

  if (okCount === 0) throw new Error('全ジャンルの取得に失敗したため中断します');

  // 前日比の計算
  for (const g of genres) {
    const items = result[g.slug];
    if (!items) continue;
    const prev = new Map((prevHistory?.genres?.[g.slug] ?? []).map(([c, r, p]) => [c, { r, p }]));
    for (const it of items) {
      const p = prev.get(it.code);
      it.hasPrev = prev.size > 0;
      it.isNew = prev.size > 0 && !p;
      it.delta = p ? p.r - it.rank : 0;
      it.priceDiff = p && p.p ? it.price - p.p : 0;
    }
  }

  // データ保存(履歴は軽量形式)
  if (okCount > 0) {
    const hist = { date: TODAY, genres: {} };
    for (const g of genres) {
      const items = result[g.slug];
      if (!items) continue;
      hist.genres[g.slug] = items.map((it) => [it.code, it.rank, it.price]);
      await writeFile(path.join(DATA, 'latest', `${g.slug}.json`),
        JSON.stringify({ updated: NOW_LABEL, items }, null, 1));
    }
    await writeFile(path.join(DATA, 'history', `${TODAY}.json`), JSON.stringify(hist));
  }

  // ---- サイト生成
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await writeFile(path.join(DIST, 'style.css'), CSS.trim() + '\n');
  await writeFile(path.join(DIST, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${site.baseUrl}/sitemap.xml\n`);

  // 急上昇(前日から10位以上アップ、またはNEW上位)
  const movers = [];
  for (const g of genres) {
    for (const it of result[g.slug] ?? []) {
      if (it.delta >= 10) movers.push({ ...it, genre: g });
    }
  }
  movers.sort((a, b) => b.delta - a.delta);
  const topMovers = movers.slice(0, 10);

  // トップページ
  const panels = genres.filter((g) => result[g.slug]).map((g) => {
    const top = result[g.slug].slice(0, 5)
      .map((it) => `<li>${esc(clip(it.name, 28))}</li>`).join('');
    return `<section class="panel"><h3>${esc(g.name)}</h3><ol>${top}</ol><a class="more" href="${g.slug}/">ランキングをもっと見る →</a></section>`;
  }).join('');

  const moverHtml = topMovers.length
    ? `<h2>急上昇ピックアップ</h2><p class="lead">前日から10位以上順位を上げた商品です。</p><ul class="list">${
      topMovers.map((it) => card(it, { showRank: false })).join('\n')}</ul>`
    : '';

  await writeFile(path.join(DIST, 'index.html'), layout({
    title: `${site.name} | 楽天市場のジャンル別ランキング(毎日更新)`,
    description: site.description,
    canonical: `${site.baseUrl}/`,
    depth: 0,
    body: `<h1>${esc(site.name)}</h1>
<p class="lead">${esc(site.description)}(${esc(NOW_LABEL)} 更新)</p>
${nav(null)}
${moverHtml}
<h2>ジャンル別ランキング</h2>
<div class="grid">${panels}</div>`,
  }));

  // ジャンル別ページ
  const urls = [`${site.baseUrl}/`];
  for (const g of genres) {
    const items = result[g.slug];
    if (!items) continue;
    await mkdir(path.join(DIST, g.slug), { recursive: true });
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `楽天市場 ${g.name} ランキング`,
      itemListElement: items.slice(0, 10).map((it) => ({
        '@type': 'ListItem', position: it.rank, name: it.name,
      })),
    };
    await writeFile(path.join(DIST, g.slug, 'index.html'), layout({
      title: `【${TODAY.replace(/-/g, '/')}】楽天市場 ${g.name}ランキング TOP${items.length} | ${site.name}`,
      description: `楽天市場の${g.name}ジャンルの人気ランキングTOP${items.length}。前日からの順位変動と価格をまとめています。(${NOW_LABEL} 更新)`,
      canonical: `${site.baseUrl}/${g.slug}/`,
      depth: 1,
      jsonLd,
      body: `<h1>楽天市場 ${esc(g.name)}ランキング</h1>
<p class="lead">リアルタイムランキング TOP${items.length}(${esc(NOW_LABEL)} 更新)。矢印は前日比の順位変動です。</p>
${nav(g.slug)}
<ul class="list">${items.map((it) => card(it)).join('\n')}</ul>`,
    }));
    urls.push(`${site.baseUrl}/${g.slug}/`);
  }

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n')}\n</urlset>\n`;
  await writeFile(path.join(DIST, 'sitemap.xml'), sitemap);

  console.log(`完了: ${okCount}/${genres.length}ジャンル → dist/ (${urls.length}ページ)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
