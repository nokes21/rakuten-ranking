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
const DIST = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(ROOT, 'dist');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
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

// 動作確認用のダミーデータ(MOCK=1 のときだけ使用)
// 商品は固定の人気度を持ち、日ごとに少しだけ揺らぐ。順位の入れ替わり・新着・価格変動が自然に出る。
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const MOCK_POOL = 42;
const MOCK_WORDS = ['送料無料', 'ポイント10倍', '選べる', '大容量', '訳あり', '2個セット', '日本製', '公式', '期間限定', 'まとめ買い'];
const MOCK_COLORS = ['#e8c4c4', '#c4d8e8', '#d6e8c4', '#e8dfc4', '#d8c4e8', '#c4e8e3', '#e8cfc4', '#c4c8e8'];
function mockImage(label, n) {
  const bg = MOCK_COLORS[n % MOCK_COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${bg}"/>` +
    `<text x="100" y="96" font-size="18" text-anchor="middle" fill="#555" font-family="sans-serif">SAMPLE</text>` +
    `<text x="100" y="124" font-size="13" text-anchor="middle" fill="#777" font-family="sans-serif">${label.slice(0, 8)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function mockRanking(genre) {
  const pool = Array.from({ length: MOCK_POOL }, (_, i) => {
    const n = i + 1;
    const key = `${genre.slug}:${n}`;
    const base = hash01(`pop:${key}`);                       // 固定の人気度
    const swing = hash01(`d:${TODAY}:${key}`) - 0.5;        // 日ごとの揺らぎ
    const roll = hash01(`p:${TODAY}:${key}`);
    const priceBase = 800 + Math.round(hash01(`pr:${key}`) * 9000 / 10) * 10;
    const priceFactor = roll < 0.14 ? 0.88 : roll < 0.2 ? 1.06 : 1; // 値下げ14%・値上げ6%
    return { n, key, score: base + swing * 0.35, priceBase, priceFactor };
  });
  pool.sort((a, b) => b.score - a.score);
  const word = (n) => MOCK_WORDS[n % MOCK_WORDS.length];
  return pool.slice(0, site.topN).map((p, idx) => ({
    rank: idx + 1,
    code: `mock-${genre.slug}:${p.n}`,
    name: `【${word(p.n)}】${genre.name}の人気アイテム No.${p.n} ${word(p.n + 3)} ${word(p.n + 5)} サンプル商品名がここに入ります`,
    price: Math.round((p.priceBase * p.priceFactor) / 10) * 10,
    url: `https://item.rakuten.co.jp/example/${p.n}/`,
    aff: `https://hb.afl.rakuten.co.jp/ichiba/${AFFILIATE_ID}/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fexample%2F${p.n}%2F`,
    img: mockImage(genre.name, p.n),
    review: Math.round((3.6 + hash01(`rv:${p.key}`) * 1.3) * 100) / 100,
    reviewCount: Math.round(5 + hash01(`rc:${p.key}`) * 3000),
    shop: `サンプルショップ${(p.n % 9) + 1}`,
    freeShipping: hash01(`fs:${p.key}`) > 0.3,
    pointRate: hash01(`pt:${p.key}`) > 0.75 ? 5 : 1,
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


const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmtMD = (dateStr) => `${Number(dateStr.slice(5, 7))}/${Number(dateStr.slice(8, 10))}`;

const TREND_DAYS = 7;       // 順位推移の表示日数
const HISTORY_DAYS = 30;    // 連続ランクイン日数の計算に使う履歴の最大日数
const RAW_KEYS = ['rank', 'code', 'name', 'price', 'url', 'aff', 'img',
  'review', 'reviewCount', 'shop', 'freeShipping', 'pointRate'];
const toRaw = (it) => Object.fromEntries(RAW_KEYS.map((k) => [k, it[k]]));

// ---------------------------------------------------------------- 履歴の分析

// 履歴ファイルを読み込み、date -> slug -> (code -> {r, p}) の索引にする
async function buildHistoryIndex() {
  const from = addDays(TODAY, -(HISTORY_DAYS - 1));
  const dates = (await loadHistoryDates()).filter((d) => d < TODAY && d >= from);
  const idx = new Map();
  for (const d of dates) {
    const h = await loadHistory(d);
    const bySlug = new Map();
    for (const [slug, rows] of Object.entries(h.genres ?? {})) {
      bySlug.set(slug, new Map(rows.map(([c, r, p]) => [c, { r, p }])));
    }
    idx.set(d, bySlug);
  }
  return { idx, dates };
}

// 1ジャンル分の商品に、前日比・7日推移・連続ランクイン日数などを付与する
function enrich(slug, items, hist) {
  const meta = { prevDate: null, prevLabel: '', hasPrev: false };
  const prevDate = [...hist.dates].reverse().find((d) => hist.idx.get(d)?.has(slug));
  let prevMap = null;
  if (prevDate) {
    prevMap = hist.idx.get(prevDate).get(slug);
    meta.prevDate = prevDate;
    meta.hasPrev = true;
    meta.prevLabel = prevDate === addDays(TODAY, -1) ? '前日' : `${fmtMD(prevDate)}`;
  }
  const trendDates = Array.from({ length: TREND_DAYS }, (_, i) => addDays(TODAY, i - (TREND_DAYS - 1)));

  for (const it of items) {
    const p = prevMap?.get(it.code);
    it.isNew = Boolean(prevMap) && !p;
    it.delta = p ? p.r - it.rank : 0;
    it.priceDiff = p && p.p ? it.price - p.p : 0;

    it.series = trendDates.map((d) =>
      (d === TODAY ? it.rank : hist.idx.get(d)?.get(slug)?.get(it.code)?.r ?? null));
    const seen = it.series.filter((v) => v !== null);
    it.best7 = Math.min(...seen);
    const firstSeen = it.series.find((v) => v !== null);
    it.weekDelta = seen.length >= 2 ? firstSeen - it.rank : 0; // 正=この1週間で上昇

    let streak = 1;
    for (let k = 1; k < HISTORY_DAYS; k++) {
      if (hist.idx.get(addDays(TODAY, -k))?.get(slug)?.has(it.code)) streak++;
      else break;
    }
    it.streak = streak;
  }
  return meta;
}

// 取得失敗で前回データを使う場合は、変動系の値を付けない(古い値を現在のように見せない)
function markStale(items) {
  for (const it of items) {
    Object.assign(it, { isNew: false, delta: 0, priceDiff: 0, series: [], best7: it.rank, weekDelta: 0, streak: 1 });
  }
}

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
};

// 注目商品: 順位・急上昇・新着・値下げ・連続ランクインを加味したスコア上位
function pickHighlights(items, n = 5) {
  const score = (it) => (31 - it.rank)
    + 2 * Math.max(it.delta, 0) + (it.isNew ? 8 : 0) + (it.priceDiff < 0 ? 5 : 0) + Math.min(it.streak - 1, 5);
  return [...items].sort((a, b) => score(b) - score(a) || a.rank - b.rank).slice(0, n);
}
const pickRising = (items, min = 5, n = 5) =>
  items.filter((i) => i.delta >= min).sort((a, b) => b.delta - a.delta || a.rank - b.rank).slice(0, n);
const pickNew = (items, n = 5) => items.filter((i) => i.isNew).sort((a, b) => a.rank - b.rank).slice(0, n);
const pickCuts = (items, n = 5) => items.filter((i) => i.priceDiff < 0 && i.price - i.priceDiff > 0)
  .sort((a, b) => a.priceDiff / (a.price - a.priceDiff) - b.priceDiff / (b.price - b.priceDiff)).slice(0, n);

// ジャンルの傾向(データから機械的に作る事実ベースの文章)
function trendText(g, items, meta, stale) {
  const prices = items.map((i) => i.price).filter((p) => p > 0);
  const free = items.filter((i) => i.freeShipping).length;
  const reviewed = items.filter((i) => i.reviewCount > 0);
  const avgReview = reviewed.length ? reviewed.reduce((s, i) => s + i.review, 0) / reviewed.length : 0;
  const shopCount = new Map();
  for (const i of items) shopCount.set(i.shop, (shopCount.get(i.shop) ?? 0) + 1);
  const [topShop, topShopN] = [...shopCount.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];

  const parts = [];
  if (prices.length) {
    parts.push(`TOP${items.length}の価格の中央値は${yen(Math.round(median(prices)))}、価格帯は${yen(Math.min(...prices))}〜${yen(Math.max(...prices))}です。`);
  }
  parts.push(`送料無料の商品は${free}件(${Math.round((free / items.length) * 100)}%)${avgReview ? `、レビュー平均は${avgReview.toFixed(2)}` : ''}です。`);
  if (topShopN >= 3) parts.push(`「${topShop}」の商品が${topShopN}件ランクインしています。`);
  if (!stale && meta.hasPrev) {
    const up = items.filter((i) => i.delta >= 5).length;
    const nw = items.filter((i) => i.isNew).length;
    const cut = items.filter((i) => i.priceDiff < 0).length;
    parts.push(`${meta.prevLabel}から新しくランクインしたのは${nw}件、5位以上順位を上げたのは${up}件、価格が下がったのは${cut}件でした。`);
  }
  return parts.join('');
}

// ---------------------------------------------------------------- HTML

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const sized = (u, px) => (u ? u.replace(/_ex=\d+x\d+/, `_ex=${px}x${px}`) : '');
const AFF_REL = 'nofollow sponsored noopener';

function layout({ title, description, canonical, depth, body, jsonLd }) {
  const root = depth === 0 ? './' : '../'.repeat(depth);
  const verify = site.googleSiteVerification
    ? `<meta name="google-site-verification" content="${esc(site.googleSiteVerification)}">` : '';
  const ld = (jsonLd ?? []).map((j) =>
    `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
${verify}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<link rel="stylesheet" href="${root}style.css">
${ld}
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
  <p>順位・価格・在庫は各ページ記載の更新日時時点の情報です。購入前に、必ず楽天市場の商品ページで最新の価格・在庫・送料をご確認ください。リンク先は楽天市場の商品ページです。</p>
  <p><a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener">Supported by Rakuten Developers</a></p>
</div></footer>
</body>
</html>
`;
}

function chip(prefix, current, g) {
  return `<a class="chip${g.slug === current ? ' on' : ''}" href="${prefix}${g.slug}/">${esc(g.name)}</a>`;
}

// 全ジャンルをグループ別に並べたナビ(内部リンク用)
function allGenresNav(prefix, current = null) {
  const groups = [...new Set(genres.map((g) => g.group))];
  return groups.map((gr) =>
    `<div class="grp"><span class="grp-name">${esc(gr)}</span><nav class="chips">${
      genres.filter((g) => g.group === gr).map((g) => chip(prefix, current, g)).join('')}</nav></div>`).join('');
}

function sameGroupNav(current) {
  const cur = genres.find((g) => g.slug === current);
  return `<nav class="chips"><a class="chip" href="../">すべてのジャンル</a>${
    genres.filter((g) => g.group === cur.group).map((g) => chip('../', current, g)).join('')}</nav>`;
}

function deltaBadge(it) {
  if (it.isNew) return '<span class="delta new">NEW</span>';
  if (it.delta > 0) return `<span class="delta up">▲${it.delta}</span>`;
  if (it.delta < 0) return `<span class="delta down">▼${-it.delta}</span>`;
  return it.series.length ? '<span class="delta flat">→</span>' : '';
}

function priceNote(it, label) {
  if (!it.priceDiff) return '';
  const cls = it.priceDiff < 0 ? 'cut' : 'rise';
  const sign = it.priceDiff < 0 ? '↓' : '↑';
  return `<span class="pdiff ${cls}">${esc(label)}比 ${sign}${yen(Math.abs(it.priceDiff))}</span>`;
}

// 直近7日の順位推移(小さな折れ線。上ほど上位)
function sparkline(it) {
  const pts = it.series.map((v, i) => (v === null ? null : { i, v })).filter(Boolean);
  if (pts.length < 2) return '';
  const W = 76, H = 24, pad = 3;
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const x = (i) => pad + (i * (W - pad * 2)) / (TREND_DAYS - 1);
  const y = (v) => (hi === lo ? H / 2 : pad + ((v - lo) * (H - pad * 2)) / (hi - lo));
  const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const dir = it.weekDelta > 0 ? 'up' : it.weekDelta < 0 ? 'down' : 'flat';
  const label = `直近${TREND_DAYS}日の順位推移(最高${it.best7}位)`;
  return `<svg class="spark ${dir}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}"><polyline points="${line}" fill="none" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.4"/></svg>`;
}

function reasonTags(it, label) {
  const t = [];
  if (it.priceDiff < 0) t.push('<span class="tag sale">値下がり</span>');
  if (it.streak >= 3) t.push(`<span class="tag">${it.streak}日連続ランクイン</span>`);
  return t.join('');
}

function card(it, { showRank = true, prevLabel = '前日', sub = '' } = {}) {
  const href = it.aff || it.url;
  const img = sized(it.img, 200);
  const stars = it.reviewCount > 0
    ? `<span class="review">★${it.review.toFixed(2)} <small>(${it.reviewCount.toLocaleString('ja-JP')}件)</small></span>` : '';
  const spark = sparkline(it);
  const trend = it.series.length && it.best7 < it.rank
    ? `<span class="best">直近${TREND_DAYS}日の最高 ${it.best7}位</span>` : '';
  return `<li class="item${showRank ? '' : ' norank'}">
  ${showRank ? `<div class="rank r${Math.min(it.rank, 4)}"><b>${it.rank}</b>位${deltaBadge(it)}</div>` : ''}
  <a class="thumb" href="${esc(href)}" target="_blank" rel="${AFF_REL}">${img ? `<img src="${esc(img)}" alt="${esc(clip(it.name, 40))}" loading="lazy" width="120" height="120">` : '<span class="noimg">No Image</span>'}</a>
  <div class="info">
    <a class="name" href="${esc(href)}" target="_blank" rel="${AFF_REL}">${esc(clip(it.name, 70))}</a>
    <div class="price">${yen(it.price)}${priceNote(it, prevLabel)}</div>
    <div class="meta">${stars}${it.freeShipping ? '<span class="tag">送料無料</span>' : ''}${it.pointRate > 1 ? `<span class="tag">ポイント${it.pointRate}倍</span>` : ''}<span class="shop">${esc(it.shop)}</span></div>
    ${sub}${reasonTags(it, prevLabel) ? `<div class="tags">${reasonTags(it, prevLabel)}</div>` : ''}
    ${spark || trend ? `<div class="trend">${spark}${trend}</div>` : ''}
    <a class="btn" href="${esc(href)}" target="_blank" rel="${AFF_REL}">楽天市場で見る</a>
  </div>
</li>`;
}

// 注目商品・急上昇などの小さな一覧
function miniList(items, { prevLabel, genre }) {
  return `<ul class="minis">${items.map((it) => {
    const href = it.aff || it.url;
    const img = sized(it.img, 64);
    const where = genre ? `<span class="where">${esc(genre.name)}</span>` : '';
    return `<li class="mini">
  <a class="mthumb" href="${esc(href)}" target="_blank" rel="${AFF_REL}">${img ? `<img src="${esc(img)}" alt="${esc(clip(it.name, 30))}" loading="lazy" width="56" height="56">` : ''}</a>
  <div class="mbody"><span class="mrank">${it.rank}位</span>${deltaBadge(it)}${where}
    <a class="mname" href="${esc(href)}" target="_blank" rel="${AFF_REL}">${esc(clip(it.name, 56))}</a>
    <span class="mprice">${yen(it.price)}${priceNote(it, prevLabel)}</span>${reasonTags(it, prevLabel)}</div>
</li>`;
  }).join('\n')}</ul>`;
}

const CSS = `
:root{--bg:#f6f6f4;--fg:#222;--sub:#666;--line:#e3e3df;--card:#fff;--red:#bf0000;--up:#d4380d;--down:#1d6fb8;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",Meiryo,sans-serif}
a{color:inherit}.wrap{max-width:860px;margin:0 auto;padding:0 16px}
.pr-bar{background:#fff7e0;border-bottom:1px solid #f0e0a8;font-size:12px;padding:6px 16px;text-align:center;color:#6b5a1a}
.header{background:var(--red);color:#fff}.header .wrap{padding:12px 16px}.logo{font-weight:700;font-size:18px;text-decoration:none}
h1{font-size:22px;margin:24px 0 4px}h2{font-size:17px;margin:32px 0 10px;border-left:4px solid var(--red);padding-left:10px}
.lead{color:var(--sub);margin:0 0 16px;font-size:13px}
.stale{background:#fff1f0;border:1px solid #ffccc7;color:#a8071a;border-radius:8px;padding:8px 12px;font-size:13px;margin:12px 0}
.note{background:#f0f7ff;border:1px solid #cfe3f7;color:#26527a;border-radius:8px;padding:8px 12px;font-size:13px;margin:12px 0}
.trendbox{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:14px;margin:0 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.chip{background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:13px;text-decoration:none}.chip.on{background:var(--red);color:#fff;border-color:var(--red)}
.grp{margin:8px 0}.grp-name{font-size:12px;color:var(--sub);font-weight:600}.grp .chips{margin:4px 0 8px}
.list{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.item{display:grid;grid-template-columns:56px 120px 1fr;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;align-items:start}
.item.norank{grid-template-columns:120px 1fr}
.rank{text-align:center;font-size:12px;color:var(--sub)}.rank b{display:block;font-size:24px;line-height:1.1;color:var(--fg)}
.rank.r1 b{color:#c9a100}.rank.r2 b{color:#8a8f98}.rank.r3 b{color:#b06a2c}
.delta{display:inline-block;font-size:11px;font-weight:700;margin:2px 0 0 4px}.rank .delta{display:block;margin-left:0}.delta.up{color:var(--up)}.delta.down{color:var(--down)}.delta.flat{color:#aaa}.delta.new{color:#fff;background:var(--red);border-radius:4px;padding:0 4px}
.thumb{display:block;width:120px;height:120px;background:#fafafa;border-radius:6px;overflow:hidden}.thumb img{width:100%;height:100%;object-fit:contain}.noimg{display:grid;place-items:center;height:100%;color:#bbb;font-size:12px}
.name{font-weight:600;text-decoration:none;display:block;margin-bottom:4px}.name:hover{text-decoration:underline}
.price{font-size:18px;font-weight:700;color:var(--red)}.pdiff{font-size:12px;font-weight:400;margin-left:8px}.pdiff.cut{color:var(--down)}.pdiff.rise{color:var(--up)}
.meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:12px;color:var(--sub);margin:4px 0 6px}.review{color:#e08a00;font-weight:600}.review small{color:var(--sub);font-weight:400}
.tags{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px}
.tag{border:1px solid #f0b4b4;color:var(--red);border-radius:4px;padding:0 5px;font-size:12px}.tag.hot{background:var(--red);border-color:var(--red);color:#fff}.tag.sale{border-color:#9cc7ee;color:var(--down)}
.trend{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--sub);margin:0 0 8px}
.spark{stroke:#999;fill:#999}.spark.up{stroke:var(--up);fill:var(--up)}.spark.down{stroke:var(--down);fill:var(--down)}
.btn{display:inline-block;background:var(--red);color:#fff;text-decoration:none;border-radius:6px;padding:6px 16px;font-size:13px;font-weight:600}
.minis{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.mini{display:flex;gap:10px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px}
.mthumb{flex:none;width:56px;height:56px;background:#fafafa;border-radius:4px;overflow:hidden}.mthumb img{width:100%;height:100%;object-fit:contain}
.mbody{font-size:13px;display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline}.mrank{font-weight:700}.mname{flex-basis:100%;text-decoration:none;font-weight:600}.mprice{color:var(--red);font-weight:700}.where{font-size:11px;color:var(--sub);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}.panel{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}.panel h3{margin:0 0 6px;font-size:15px}.panel a.more{font-size:12px}
.panel ol{margin:0;padding-left:1.4em;font-size:13px}.panel li{margin:2px 0}
.footer{margin-top:40px;border-top:1px solid var(--line);padding:16px 0 40px;font-size:12px;color:var(--sub)}
@media(max-width:560px){h1{font-size:19px}.item{grid-template-columns:44px 88px 1fr;gap:8px;padding:10px}.item.norank{grid-template-columns:88px 1fr}.thumb{width:88px;height:88px}.price{font-size:16px}}
`;

// ---------------------------------------------------------------- メイン

async function main() {
  if (!MOCK && (!APP_ID || !ACCESS_KEY)) {
    throw new Error('RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY が未設定です (テスト時は MOCK=1)');
  }
  const mockFail = new Set((process.env.MOCK_FAIL ?? '').split(',').filter(Boolean));

  const hist = await buildHistoryIndex();
  await mkdir(path.join(DATA, 'latest'), { recursive: true });
  await mkdir(path.join(DATA, 'history'), { recursive: true });

  // ---- 取得
  const R = {}; // slug -> { items, fresh, dataDate, meta }
  for (const [i, g] of genres.entries()) {
    try {
      if (MOCK && mockFail.has(g.slug)) throw new Error('(テスト)取得失敗を再現');
      const items = MOCK ? mockRanking(g) : await fetchRanking(g);
      if (items.length < 3) throw new Error(`取得件数が少なすぎます(${items.length}件)`);
      R[g.slug] = { items, fresh: true, dataDate: TODAY };
      console.log(`✓ ${g.name}: ${items.length}件`);
    } catch (e) {
      console.error(`✗ ${g.name}: ${e.message}`);
      const fb = path.join(DATA, 'latest', `${g.slug}.json`);
      if (existsSync(fb)) {
        const saved = JSON.parse(await readFile(fb, 'utf8'));
        R[g.slug] = { items: saved.items, fresh: false, dataDate: saved.date ?? '' };
        console.warn(`  → ${saved.date ?? '日付不明'}のデータを「古いデータ」として表示します`);
      }
    }
    if (!MOCK && i < genres.length - 1) await sleep(1200); // APIへの負荷配慮
  }
  const freshCount = Object.values(R).filter((r) => r.fresh).length;
  if (freshCount === 0) throw new Error('全ジャンルの取得に失敗したため中断します');

  // ---- 分析
  for (const g of genres) {
    const r = R[g.slug];
    if (!r) continue;
    if (r.fresh) r.meta = enrich(g.slug, r.items, hist);
    else { markStale(r.items); r.meta = { prevDate: null, prevLabel: '', hasPrev: false }; }
  }

  // ---- 保存(取得成功したジャンルのみ。古いデータで履歴や最新データを上書きしない)
  const today = { date: TODAY, genres: {} };
  for (const g of genres) {
    const r = R[g.slug];
    if (!r?.fresh) continue;
    today.genres[g.slug] = r.items.map((it) => [it.code, it.rank, it.price]);
    await writeFile(path.join(DATA, 'latest', `${g.slug}.json`),
      JSON.stringify({ date: TODAY, updated: NOW_LABEL, items: r.items.map(toRaw) }, null, 1));
  }
  await writeFile(path.join(DATA, 'history', `${TODAY}.json`), JSON.stringify(today));

  // ---- サイト生成
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await writeFile(path.join(DIST, 'style.css'), CSS.trim() + '\n');
  await writeFile(path.join(DIST, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${site.baseUrl}/sitemap.xml\n`);

  const live = genres.filter((g) => R[g.slug]);
  const urls = [{ loc: `${site.baseUrl}/`, lastmod: TODAY }];

  // トップページ: 急上昇ピックアップ(最新データのジャンルのみ)
  const movers = [];
  for (const g of live) {
    if (!R[g.slug].fresh) continue;
    for (const it of R[g.slug].items) if (it.delta >= 10) movers.push({ ...it, _g: g, _label: R[g.slug].meta.prevLabel });
  }
  movers.sort((a, b) => b.delta - a.delta);
  const moverHtml = movers.length
    ? `<h2>今、急上昇している商品</h2><p class="lead">前日などから10位以上順位を上げた商品です。</p><ul class="minis">${
      movers.slice(0, 10).map((it) => miniList([it], { prevLabel: it._label, genre: it._g }).replace(/^<ul class="minis">|<\/ul>$/g, '')).join('\n')}</ul>`
    : '';

  const panels = live.map((g) => {
    const top = R[g.slug].items.slice(0, 5).map((it) => `<li>${esc(clip(it.name, 28))}</li>`).join('');
    return `<section class="panel"><h3>${esc(g.name)}</h3><ol>${top}</ol><a class="more" href="${g.slug}/">${esc(g.name)}ランキングをもっと見る →</a></section>`;
  }).join('');

  await writeFile(path.join(DIST, 'index.html'), layout({
    title: `${site.name}｜楽天市場の売れ筋・急上昇商品をジャンル別に毎日更新`,
    description: site.description,
    canonical: `${site.baseUrl}/`,
    depth: 0,
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: `${site.baseUrl}/` }],
    body: `<h1>${esc(site.name)}</h1>
<p class="lead">${esc(site.description)}(${esc(NOW_LABEL)} 更新)</p>
${allGenresNav('')}
${moverHtml}
<h2>ジャンル別ランキング</h2>
<div class="grid">${panels}</div>`,
  }));

  // ジャンル別ページ
  for (const g of live) {
    const r = R[g.slug];
    const { items, meta } = r;
    const stale = !r.fresh;
    const label = meta.prevLabel || '前日';
    const dateLabel = stale ? fmtMD(r.dataDate || TODAY) : fmtMD(TODAY);

    const rising = pickRising(items), fresh = pickNew(items), cuts = pickCuts(items);
    const cnt = { up: items.filter((i) => i.delta >= 5).length, nw: items.filter((i) => i.isNew).length, cut: cuts.length };

    const section = (title, list, desc) => (list.length
      ? `<h2>${title}</h2><p class="lead">${desc}</p>${miniList(list, { prevLabel: label })}` : '');

    const staleBanner = stale
      ? `<p class="stale">※このジャンルは最新データの取得に失敗したため、<b>${esc(r.dataDate ? fmtMD(r.dataDate) : '過去')}時点</b>の情報を表示しています。順位・価格は現在と異なる場合があります。変動情報は表示していません。</p>` : '';
    const histNote = !stale && !meta.hasPrev
      ? '<p class="note">順位の変動・価格の変化・7日間の推移は、データが溜まる2日目以降に表示されます。</p>' : '';

    const body = `<h1>楽天市場 ${esc(g.name)}ランキング</h1>
<p class="lead">${esc(g.name)}ジャンルのリアルタイムランキング TOP${items.length}。${stale ? `${esc(dateLabel)}時点のデータです。` : `${esc(NOW_LABEL)} に更新しました。`}</p>
${staleBanner}${histNote}
${sameGroupNav(g.slug)}
<h2>${stale ? '注目商品' : '今日の注目商品'} TOP${Math.min(5, items.length)}</h2>
<p class="lead">順位に加えて、${stale ? '' : '急上昇・新着・値下がり・連続ランクインを加味して'}選んでいます。</p>
${miniList(pickHighlights(items), { prevLabel: label })}
${stale ? '' : section('急上昇した商品', rising, `${esc(label)}から5位以上順位を上げた商品です。`)}
${stale ? '' : section('新しくランクインした商品', fresh, `${esc(label)}はTOP${items.length}圏外だった商品です。`)}
${stale ? '' : section('価格が下がった商品', cuts, `${esc(label)}より価格が下がった商品です(下落率の大きい順)。`)}
<h2>${esc(g.name)}ランキングの傾向</h2>
<div class="trendbox">${esc(trendText(g, items, meta, stale))}</div>
<h2>${esc(g.name)}ランキング TOP${items.length}</h2>
<p class="lead">矢印は${esc(label)}比の順位変動、折れ線は直近${TREND_DAYS}日の順位推移(上ほど上位)です。</p>
<ul class="list">${items.map((it) => card(it, { prevLabel: label })).join('\n')}</ul>
<h2>ほかのジャンルのランキング</h2>
${allGenresNav('../', g.slug)}`;

    const descParts = [`楽天市場の${g.name}ジャンルで今売れている商品TOP${items.length}。`];
    if (!stale && meta.hasPrev) {
      descParts.push(`急上昇${cnt.up}件・新着ランクイン${cnt.nw}件・値下がり${cnt.cut}件。`);
    }
    descParts.push(`毎日更新(${dateLabel}${stale ? '時点' : '更新'})。`);

    await mkdir(path.join(DIST, g.slug), { recursive: true });
    await writeFile(path.join(DIST, g.slug, 'index.html'), layout({
      title: `楽天${g.name}ランキング｜売れ筋・急上昇商品を毎日更新`,
      description: descParts.join(''),
      canonical: `${site.baseUrl}/${g.slug}/`,
      depth: 1,
      jsonLd: [
        {
          '@context': 'https://schema.org', '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: site.name, item: `${site.baseUrl}/` },
            { '@type': 'ListItem', position: 2, name: `${g.name}ランキング`, item: `${site.baseUrl}/${g.slug}/` },
          ],
        },
        {
          '@context': 'https://schema.org', '@type': 'ItemList',
          name: `楽天市場 ${g.name}ランキング`,
          itemListElement: items.slice(0, 10).map((it) => ({ '@type': 'ListItem', position: it.rank, name: it.name })),
        },
      ],
      body,
    }));
    urls.push({ loc: `${site.baseUrl}/${g.slug}/`, lastmod: stale && r.dataDate ? r.dataDate : TODAY });
  }

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`;
  await writeFile(path.join(DIST, 'sitemap.xml'), sitemap);

  const staleCount = live.length - freshCount;
  console.log(`完了: 最新${freshCount}ジャンル${staleCount ? ` / 古いデータ${staleCount}ジャンル` : ''} → dist/ (${urls.length}ページ)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
