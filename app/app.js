'use strict';

/* =========================================================================
   デッキ確率ラボ
   - 60枚デッキ / 初手7枚 / サイド6枚 を前提にした確率計算
   - 厳密計算は超幾何分布、マリガンを含む複合条件はモンテカルロ
   ========================================================================= */

const DECK_SIZE = 60;
const HAND_SIZE = 7;
const PRIZE_SIZE = 6;
const TRIALS = 50000;

/* ---------- 超幾何分布 ---------------------------------------------------
   log階乗表で計算する。60C30 は double の整数精度(2^53)を超えるため、
   組み合わせ数を直接持たず対数で扱う。
   ------------------------------------------------------------------------ */
const LOGFACT = [0];
for (let i = 1; i <= DECK_SIZE + 1; i++) LOGFACT[i] = LOGFACT[i - 1] + Math.log(i);

function logC(n, k) {
  if (k < 0 || k > n || n < 0) return -Infinity;
  return LOGFACT[n] - LOGFACT[k] - LOGFACT[n - k];
}

/** N枚の母集団にK枚ある当たりを、n枚引いたときちょうどx枚含む確率 */
function hgPMF(N, K, n, x) {
  if (x < 0 || x > K || n - x < 0 || n - x > N - K) return 0;
  const v = logC(K, x) + logC(N - K, n - x) - logC(N, n);
  return v === -Infinity ? 0 : Math.exp(v);
}

/** 同条件で x >= k となる確率 */
function hgAtLeast(N, K, n, k) {
  if (k <= 0) return 1;
  let s = 0;
  const hi = Math.min(K, n);
  for (let x = k; x <= hi; x++) s += hgPMF(N, K, n, x);
  return Math.min(1, Math.max(0, s));
}

/* ---------- カード名の自動判定用データ ------------------------------------
   あくまで入力補助のための既定値。UI 側で必ず上書きできるようにしてある。
   ------------------------------------------------------------------------ */
const SUPPORTER_NAMES = [
  '博士の研究','ナンジャモ','ボスの指令','ペパー','アカマツ','ネモ','オモダカ','カイ',
  'セレナ','リーリエ','マリィ','シロナ','キハダ','ジャッジマン','エリカのおもてなし',
  'クセロシキ','スグリ','ブライア','サナ','アンズ','マツバ','ジャッジ',
  "professor's research",'iono','boss’s orders',"boss's orders",'arven','nemona','judge',
  'cynthia','marnie','lillie','erika’s invitation',"erika's invitation",'briar','crispin',
  'professor turo','professor sada','colress','guzma','serena','penny','carmine',
];
const DRAW_SUPPORTER_NAMES = [
  '博士の研究','ナンジャモ','キハダ','ネモ','シロナ','マリィ','リーリエ','ジャッジマン','サナ',
  "professor's research",'iono','nemona','judge','cynthia','marnie','lillie',
  'professor turo','professor sada','colress','colress’s experiment',
];
const STADIUM_HINT = ['スタジアム','ジム','タワー','神殿','遺跡','スタジオ','stadium','gym'];
const TOOL_HINT = ['のどうぐ','ベルト','おまもり','チョッキ','tool','vest','band','charm'];
const ENERGY_HINT = ['エネルギー','energy'];

const CATEGORIES = ['ポケモン', 'サポート', 'グッズ', 'どうぐ', 'スタジアム', 'エネルギー'];

function norm(s) { return s.trim().toLowerCase(); }
function hasAny(name, list) {
  const n = norm(name);
  return list.some(w => n.includes(norm(w)));
}

/* ---------- デッキリストの解析 -------------------------------------------- */

const SECTION_RE = /^\s*(pok[eé]mon|ポケモン|trainer|トレーナー|グッズ|サポート|スタジアム|energy|エネルギー|total\s*cards|合計|計)\s*[:：]?\s*\d*\s*$/i;

/** PTCGL 書き出しの末尾セット記号 (例: " SVI 181", " PAF 91") を落とす */
function stripSetCode(name) {
  return name
    .replace(/\s+[A-Z]{2,5}\s+\d+[a-zA-Z]?\s*$/, '')
    .replace(/\s+(?:PH|RH)\s*$/i, '')
    .trim();
}

function sectionOf(line) {
  const m = line.match(SECTION_RE);
  if (!m) return null;
  const k = norm(m[1]);
  if (k === 'pokémon' || k === 'pokemon' || k === 'ポケモン') return 'ポケモン';
  if (k === 'energy' || k === 'エネルギー') return 'エネルギー';
  if (k === 'サポート') return 'サポート';
  if (k === 'グッズ') return 'グッズ';
  if (k === 'スタジアム') return 'スタジアム';
  if (k === 'trainer' || k === 'トレーナー') return 'グッズ';
  return 'SKIP'; // 合計行など
}

function guessCategory(name, section) {
  if (section === 'ポケモン') return 'ポケモン';
  if (hasAny(name, ENERGY_HINT)) return 'エネルギー';
  if (section === 'エネルギー') return 'エネルギー';
  if (hasAny(name, SUPPORTER_NAMES)) return 'サポート';
  if (hasAny(name, TOOL_HINT)) return 'どうぐ';
  if (hasAny(name, STADIUM_HINT)) return 'スタジアム';
  return section || 'グッズ';
}

function parseDeck(text) {
  const cards = [];
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const sec = sectionOf(line);
    if (sec) { if (sec !== 'SKIP') section = sec; continue; }

    let count = null, name = null;
    let m = line.match(/^(\d{1,2})\s*[x×]?\s+(.+)$/);        // 「4 カード名」
    if (m) { count = +m[1]; name = m[2]; }
    else {
      m = line.match(/^(.+?)\s+[x×]?\s*(\d{1,2})\s*(?:枚)?$/); // 「カード名 4」
      if (m) { name = m[1]; count = +m[2]; }
    }
    if (count === null || !name) continue;

    name = stripSetCode(name).replace(/\s{2,}/g, ' ').trim();
    if (!name || count < 1 || count > 60) continue;

    const existing = cards.find(c => c.name === name);
    if (existing) { existing.count += count; continue; }

    const cat = guessCategory(name, section);
    cards.push({
      name,
      count,
      cat,
      basic: cat === 'ポケモン',                       // 進化はユーザーが外す前提
      draw: cat === 'サポート' && hasAny(name, DRAW_SUPPORTER_NAMES),
    });
  }
  return cards;
}

/* ---------- 状態 ---------------------------------------------------------- */

let cards = [];

const $ = sel => document.querySelector(sel);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const pct = p => (p * 100).toFixed(1) + '%';

function totalCards() { return cards.reduce((s, c) => s + c.count, 0); }
function totalOf(pred) { return cards.reduce((s, c) => s + (pred(c) ? c.count : 0), 0); }

/** 現在の条件で「見えている」枚数 = 初手7 + ターン中のドロー + 追加ドロー */
function seenCount() {
  const ruleset = $('#ruleset').value;
  const order = $('#turnorder').value;
  const turn = Math.max(1, +$('#turn').value || 1);
  const extra = Math.max(0, +$('#extradraw').value || 0);
  // 先攻がターン1にドローしないルールでは、先攻のドロー回数は turn-1
  const skipFirst = (ruleset === 'jp' && order === 'first');
  const turnDraws = skipFirst ? turn - 1 : turn;
  const seen = Math.min(DECK_SIZE - PRIZE_SIZE, HAND_SIZE + turnDraws + extra);
  return { seen, turnDraws, extra };
}

/* ---------- 2. カード表の描画 --------------------------------------------- */

function renderCardTable() {
  const tb = $('#cardtable tbody');
  tb.textContent = '';

  cards.forEach((c, i) => {
    const tr = el('tr');

    const tdN = el('td', 'c-n');
    const inN = el('input'); inN.type = 'number'; inN.min = '1'; inN.max = '60';
    inN.value = c.count; inN.inputMode = 'numeric';
    inN.addEventListener('change', () => {
      c.count = Math.max(1, Math.min(60, +inN.value || 1));
      inN.value = c.count; refresh();
    });
    tdN.append(inN); tr.append(tdN);

    const tdName = el('td', 'name'); tdName.textContent = c.name; tr.append(tdName);

    const tdCat = el('td');
    const sel = el('select');
    for (const cat of CATEGORIES) {
      const o = el('option'); o.value = cat; o.textContent = cat;
      if (cat === c.cat) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      c.cat = sel.value;
      if (c.cat !== 'ポケモン') c.basic = false;
      if (c.cat !== 'サポート') c.draw = false;
      renderCardTable(); refresh();
    });
    tdCat.append(sel); tr.append(tdCat);

    // ポケモンなら「たね」、サポートなら「ドロー」。両立しないので1列にまとめる
    const tdF = el('td', 'c-c');
    if (c.cat === 'ポケモン' || c.cat === 'サポート') {
      const isPoke = c.cat === 'ポケモン';
      const wrap = el('label', 'flagcell');
      const cb = el('input'); cb.type = 'checkbox';
      cb.checked = isPoke ? c.basic : c.draw;
      cb.title = isPoke ? 'たねポケモン' : 'ドローサポート';
      cb.addEventListener('change', () => {
        if (isPoke) c.basic = cb.checked; else c.draw = cb.checked;
        refresh();
      });
      const cap = el('span', 'flaglab'); cap.textContent = isPoke ? 'たね' : 'ドロー';
      wrap.append(cb, cap);
      tdF.append(wrap);
    } else tdF.textContent = '–';
    tr.append(tdF);

    const tdX = el('td', 'c-x');
    const rm = el('button', 'rm'); rm.textContent = '×'; rm.title = '削除';
    rm.addEventListener('click', () => { cards.splice(i, 1); renderAll(); });
    tdX.append(rm); tr.append(tdX);

    tb.append(tr);
  });

  const total = totalCards();
  const sum = $('#decksummary');
  sum.textContent = '';
  const chips = [
    ['合計 ' + total + '枚', total === DECK_SIZE ? 'good' : 'bad'],
    ['ポケモン ' + totalOf(c => c.cat === 'ポケモン'), ''],
    ['たね ' + totalOf(c => c.basic), ''],
    ['サポート ' + totalOf(c => c.cat === 'サポート'), ''],
    ['グッズ ' + totalOf(c => c.cat === 'グッズ'), ''],
    ['エネルギー ' + totalOf(c => c.cat === 'エネルギー'), ''],
  ];
  for (const [t, cls] of chips) {
    const s = el('span', 'chip' + (cls ? ' ' + cls : '')); s.textContent = t; sum.append(s);
  }
}

/* ---------- 4. 診断 -------------------------------------------------------- */

function renderDiagnostics() {
  const total = totalCards();
  const basics = totalOf(c => c.basic);
  const draws = totalOf(c => c.draw);
  const supporters = totalOf(c => c.cat === 'サポート');
  const energy = totalOf(c => c.cat === 'エネルギー');

  // マリガン率 = 初手7枚にたねが1枚も入らない確率
  const mull = total === DECK_SIZE ? 1 - hgAtLeast(DECK_SIZE, basics, HAND_SIZE, 1) : null;
  const { seen } = seenCount();
  const drawOpen = total === DECK_SIZE ? hgAtLeast(DECK_SIZE, draws, HAND_SIZE, 1) : null;

  const grid = $('#statgrid');
  grid.textContent = '';
  const stat = (lab, val, note, cls) => {
    const d = el('div', 'stat' + (cls ? ' ' + cls : ''));
    const l = el('span', 'lab'); l.textContent = lab;
    const v = el('span', 'val'); v.textContent = val;
    d.append(l, v);
    if (note) { const n = el('span', 'note'); n.textContent = note; d.append(n); }
    return d;
  };

  grid.append(stat('マリガン率', mull === null ? '—' : pct(mull),
    'たね ' + basics + '枚', mull === null ? '' : mull > 0.12 ? 'bad' : mull > 0.08 ? 'warn' : 'good'));
  grid.append(stat('初手にドロサポ', drawOpen === null ? '—' : pct(drawOpen),
    'ドロサポ ' + draws + '枚', drawOpen === null ? '' : drawOpen < 0.5 ? 'warn' : 'good'));
  grid.append(stat('見えるカード', seen + '枚', '初手7 + ドロー' + (seen - HAND_SIZE)));
  grid.append(stat('デッキ枚数', total + '枚', total === DECK_SIZE ? '' : DECK_SIZE + '枚にしてください',
    total === DECK_SIZE ? 'good' : 'bad'));

  const ul = $('#warnings');
  ul.textContent = '';
  const warn = (cls, text) => { const li = el('li', cls); li.textContent = text; ul.append(li); };

  if (total !== DECK_SIZE) {
    warn('bad', '合計が ' + total + '枚です。60枚でないと以下の確率は正しくありません。');
  }
  const over = cards.filter(c => c.count > 4 && c.cat !== 'エネルギー');
  if (over.length) {
    warn('bad', '同名カードが4枚を超えています: ' + over.map(c => c.name + '(' + c.count + ')').join('、'));
  }
  if (basics === 0) warn('bad', 'たねポケモンが0枚です。ゲームを始められません。種別と「たね」チェックを確認してください。');
  else if (mull !== null && mull > 0.12) warn('bad', 'マリガン率 ' + pct(mull) + ' は高めです。たねを増やすと安定します。');
  else if (mull !== null && mull > 0.08) warn('warn', 'マリガン率 ' + pct(mull) + '。もう1〜2枚たねを足すと落ち着きます。');
  else if (mull !== null) warn('ok', 'マリガン率 ' + pct(mull) + '。たねの枚数は十分です。');

  if (supporters === 0) warn('warn', 'サポートが0枚です。種別の設定漏れかもしれません。');
  else if (draws === 0) warn('warn', 'ドローサポートが0枚です。該当するサポートに「ドロサポ」チェックを入れてください。');
  else if (drawOpen !== null && drawOpen < 0.5) {
    warn('warn', '初手にドローサポートがある確率が ' + pct(drawOpen) + ' しかありません。ドロサポ ' + draws + '枚は少なめです。');
  }
  if (energy === 0) warn('warn', 'エネルギーが0枚です。意図的でなければ種別を確認してください。');
  if (!ul.children.length) warn('ok', '目立った問題は見つかりませんでした。');
}

/* ---------- 5. カード別確率 ------------------------------------------------ */

function renderPerCard() {
  const { seen } = seenCount();
  const tb = $('#pertable tbody');
  tb.textContent = '';

  const sorted = cards.slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  for (const c of sorted) {
    const K = c.count;
    const open = hgAtLeast(DECK_SIZE, K, HAND_SIZE, 1);
    const now = hgAtLeast(DECK_SIZE, K, seen, 1);
    const prizedAny = hgAtLeast(DECK_SIZE, K, PRIZE_SIZE, 1);
    const prizedAll = hgAtLeast(DECK_SIZE, K, PRIZE_SIZE, K);

    const tr = el('tr');
    const n = el('td', 'name'); n.textContent = c.name + ' ×' + K; tr.append(n);
    for (const v of [open, now, prizedAny, prizedAll]) {
      const td = el('td', 'c-p'); td.textContent = pct(v); tr.append(td);
    }
    tb.append(tr);
  }
}

/* ---------- 6. コンボ確率 (モンテカルロ) ----------------------------------- */

function renderComboList() {
  const box = $('#combolist');
  const prev = {};
  box.querySelectorAll('.combo-row').forEach(r => {
    prev[r.dataset.name] = { on: r.querySelector('input[type=checkbox]').checked, need: +r.querySelector('.cneed').value };
  });
  box.textContent = '';

  for (const c of cards) {
    const row = el('div', 'combo-row');
    row.dataset.name = c.name;

    const cb = el('input'); cb.type = 'checkbox';
    cb.checked = prev[c.name] ? prev[c.name].on : false;

    const nm = el('span', 'cname'); nm.textContent = c.name;

    const need = el('input', 'cneed');
    need.type = 'number'; need.min = '1'; need.max = String(c.count);
    need.value = String(Math.min(prev[c.name] ? prev[c.name].need || 1 : 1, c.count));
    need.inputMode = 'numeric';

    const max = el('span', 'cmax'); max.textContent = '/ ' + c.count + '枚';

    row.append(cb, nm, need, max);
    box.append(row);
  }
}

function readComboTargets() {
  const out = [];
  document.querySelectorAll('#combolist .combo-row').forEach(r => {
    if (!r.querySelector('input[type=checkbox]').checked) return;
    const c = cards.find(x => x.name === r.dataset.name);
    if (!c) return;
    const need = Math.max(1, Math.min(c.count, +r.querySelector('.cneed').value || 1));
    out.push({ card: c, need });
  });
  return out;
}

/** デッキを「カードID配列」に展開する。未使用枠は -1。 */
function buildDeckArray(idOf) {
  const deck = [];
  cards.forEach((c, i) => {
    const id = idOf.has(i) ? i : -1;
    for (let k = 0; k < c.count; k++) deck.push(id);
  });
  while (deck.length < DECK_SIZE) deck.push(-1);
  return deck.slice(0, DECK_SIZE);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
}

/**
 * 山札を実際に混ぜて数える。
 * 先頭7枚=初手、次の6枚=サイド、その後ろから順にドロー。
 * たねが初手に無ければ引き直し(マリガン)。
 */
function simulateCombo(targets, seen, trials) {
  const idx = new Set(targets.map(t => cards.indexOf(t.card)));
  const basicFlags = cards.map(c => !!c.basic);
  const deck = buildDeckArray(idx);
  const basicDeck = [];
  cards.forEach((c, i) => { for (let k = 0; k < c.count; k++) basicDeck.push(basicFlags[i]); });
  while (basicDeck.length < DECK_SIZE) basicDeck.push(false);

  // カードIDと「たねかどうか」を同じ並びで持つため、ペアで詰め直す
  const pair = deck.map((id, i) => (basicDeck[i] ? id * 2 + 1 : id * 2)); // 下位1bitに basic を格納
  const needByIdx = new Map(targets.map(t => [cards.indexOf(t.card), t.need]));
  const counts = new Int32Array(cards.length);

  let hits = 0, mulligans = 0, mulliganTrials = 0;

  for (let t = 0; t < trials; t++) {
    shuffle(pair);

    // マリガン処理: 初手7枚にたねが無ければ引き直す
    let redraws = 0;
    let hadMulligan = false;
    for (;;) {
      let ok = false;
      for (let i = 0; i < HAND_SIZE; i++) if (pair[i] & 1) { ok = true; break; }
      if (ok) break;
      hadMulligan = true;
      if (++redraws > 100) break;      // たね0枚デッキの無限ループ回避
      shuffle(pair);
    }
    if (hadMulligan) mulliganTrials++;
    mulligans += redraws;

    // 見えているカード = 初手7枚 + サイド6枚の後ろから引いた分
    counts.fill(0);
    for (let i = 0; i < HAND_SIZE; i++) {
      const id = pair[i] >> 1; if (id >= 0) counts[id]++;
    }
    const drawn = seen - HAND_SIZE;
    for (let i = 0; i < drawn; i++) {
      const id = pair[HAND_SIZE + PRIZE_SIZE + i] >> 1; if (id >= 0) counts[id]++;
    }

    let ok = true;
    for (const [i, need] of needByIdx) if (counts[i] < need) { ok = false; break; }
    if (ok) hits++;
  }

  const p = hits / trials;
  return {
    p,
    se: Math.sqrt(Math.max(p * (1 - p), 1e-12) / trials),
    mulliganRate: mulliganTrials / trials,
    avgMulligans: mulligans / trials,
  };
}

function runCombo() {
  const box = $('#comboresult');
  box.textContent = '';
  const targets = readComboTargets();

  if (!targets.length) {
    const p = el('p', 'hint'); p.textContent = 'カードを1枚以上選んでください。';
    box.append(p); return;
  }
  if (totalCards() !== DECK_SIZE) {
    const p = el('p', 'hint');
    p.textContent = 'デッキが60枚ではないため計算できません(現在 ' + totalCards() + '枚)。';
    box.append(p); return;
  }
  if (totalOf(c => c.basic) === 0) {
    const p = el('p', 'hint');
    p.textContent = 'たねポケモンが0枚だとゲームが成立しないため計算できません。';
    box.append(p); return;
  }

  const { seen } = seenCount();
  const r = simulateCombo(targets, seen, TRIALS);

  const wrap = el('div', 'bigresult');
  const lab = el('span', 'lab');
  lab.textContent = targets.map(t => t.card.name + (t.need > 1 ? '×' + t.need : '')).join(' + ') + ' が揃う確率';
  const val = el('span', 'val'); val.textContent = pct(r.p);
  const ci = el('span', 'ci');
  ci.textContent = '95%信頼区間 ±' + (r.se * 1.96 * 100).toFixed(2) + 'pt / ' +
    TRIALS.toLocaleString() + '回試行 / 見えるカード ' + seen + '枚 / マリガン率 ' + pct(r.mulliganRate);
  wrap.append(lab, val, ci);
  box.append(wrap);
}

/* ---------- 7. 採用枚数の比較 ---------------------------------------------- */

function renderCountCompare() {
  const sel = $('#countcard');
  const keep = sel.value;
  sel.textContent = '';
  cards.forEach(c => {
    const o = el('option'); o.value = c.name; o.textContent = c.name + '(現在 ' + c.count + '枚)';
    sel.append(o);
  });
  if (keep && cards.some(c => c.name === keep)) sel.value = keep;

  const target = cards.find(c => c.name === sel.value);
  const tb = $('#counttable tbody');
  tb.textContent = '';
  if (!target) return;

  const { seen } = seenCount();
  for (let k = 1; k <= 4; k++) {
    const tr = el('tr');
    if (k === target.count) tr.style.fontWeight = '700';
    const c0 = el('td'); c0.textContent = k + '枚' + (k === target.count ? '(現在)' : '');
    tr.append(c0);
    const vals = [
      hgAtLeast(DECK_SIZE, k, HAND_SIZE, 1),
      hgAtLeast(DECK_SIZE, k, seen, 1),
      hgAtLeast(DECK_SIZE, k, PRIZE_SIZE, k),
    ];
    for (const v of vals) { const td = el('td', 'c-p'); td.textContent = pct(v); tr.append(td); }
    tb.append(tr);
  }
}

/* ---------- 描画のまとめ --------------------------------------------------- */

function updateSeenLabel() {
  const { seen, turnDraws, extra } = seenCount();
  $('#seencount').textContent = seen;
  $('#seenbreak').textContent =
    '内訳: 初手 ' + HAND_SIZE + ' + ターンドロー ' + turnDraws + ' + 追加ドロー ' + extra +
    '(サイド ' + PRIZE_SIZE + '枚は引けない前提)';
}

function refresh() {
  updateSeenLabel();
  renderDiagnostics();
  renderPerCard();
  renderCountCompare();
  save();
}

function renderAll() {
  const has = cards.length > 0;
  for (const id of ['sec-cards', 'sec-settings', 'sec-diag', 'sec-per', 'sec-combo', 'sec-counts']) {
    $('#' + id).classList.toggle('hidden', !has);
  }
  if (!has) return;
  renderCardTable();
  renderComboList();
  refresh();
}

/* ---------- 保存 ----------------------------------------------------------- */

const KEY = 'deck-prob-lab-v1';
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      text: $('#decklist').value,
      cards,
      ruleset: $('#ruleset').value,
      turnorder: $('#turnorder').value,
      turn: $('#turn').value,
      extradraw: $('#extradraw').value,
    }));
  } catch (e) { /* プライベートモード等では保存できない。無視して続行する */ }
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.cards) || !d.cards.length) return false;
    $('#decklist').value = d.text || '';
    cards = d.cards;
    if (d.ruleset) $('#ruleset').value = d.ruleset;
    if (d.turnorder) $('#turnorder').value = d.turnorder;
    if (d.turn) $('#turn').value = d.turn;
    if (d.extradraw) $('#extradraw').value = d.extradraw;
    return true;
  } catch (e) { return false; }
}

/* ---------- サンプル ------------------------------------------------------- */

const SAMPLE = `ポケモン 13
4 たねポケモンA
3 たねポケモンB
2 進化ポケモンB1
2 たねポケモンC
2 進化ポケモンC1

トレーナー 34
4 博士の研究
4 ナンジャモ
2 ボスの指令
4 ネストボール
4 ハイパーボール
3 なかよしポフィン
3 すごいつりざお
2 ふしぎなアメ
4 ポケモンのどうぐA
4 スタジアムA

エネルギー 13
9 基本エネルギーA
4 特殊エネルギーB`;

/* ---------- 起動 ----------------------------------------------------------- */

function boot() {
  $('#btn-parse').addEventListener('click', () => {
    const parsed = parseDeck($('#decklist').value);
    if (!parsed.length) { alert('カードを読み取れませんでした。「4 カード名」の形式で入力してください。'); return; }
    cards = parsed;
    renderAll();
    $('#sec-cards').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#btn-sample').addEventListener('click', () => {
    $('#decklist').value = SAMPLE;
    cards = parseDeck(SAMPLE);
    renderAll();
    $('#sec-cards').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#btn-clear').addEventListener('click', () => {
    $('#decklist').value = ''; cards = []; renderAll();
    try { localStorage.removeItem(KEY); } catch (e) { /* 保存不可でも問題ない */ }
  });

  for (const id of ['#ruleset', '#turnorder', '#turn', '#extradraw']) {
    $(id).addEventListener('change', refresh);
    $(id).addEventListener('input', refresh);
  }
  $('#countcard').addEventListener('change', renderCountCompare);
  $('#btn-combo').addEventListener('click', runCombo);

  if (load()) renderAll(); else updateSeenLabel();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}

document.addEventListener('DOMContentLoaded', boot);
