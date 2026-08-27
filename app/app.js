'use strict';

/* =========================================================================
   app.js — 確率ラボ
   厳密計算は超幾何分布、マリガンを含む複合条件はモンテカルロで求める。
   デッキ枚数・初手枚数・伏せ札の枚数はゲームによって違うので、
   定数で決め打ちにせず、読み込んだデッキと設定から毎回組み立てる。
   ========================================================================= */

const D = window.DeckLib;
const TRIALS = 50000;

/* ---------- 超幾何分布 ---------------------------------------------------
   log階乗表で計算する。60C30 は double の整数精度(2^53)を超えるため、
   組み合わせ数を直接持たず対数で扱う。
   ------------------------------------------------------------------------ */
const LOGFACT = [0];
for (let i = 1; i <= 400; i++) LOGFACT[i] = LOGFACT[i - 1] + Math.log(i);

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
  if (N <= 0 || n <= 0) return 0;
  let s = 0;
  const hi = Math.min(K, n);
  for (let x = k; x <= hi; x++) s += hgPMF(N, K, n, x);
  return Math.min(1, Math.max(0, s));
}

/* ---------- 状態 ---------------------------------------------------------- */

let gid = D.DEFAULT_GAME;
let cards = [];

const KEY_LAB = 'tcg-lab-v1';
const $ = sel => document.querySelector(sel);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const pct = p => (p * 100).toFixed(1) + '%';

/** 計算対象はメインデッキだけ。エクストラは別の山なので数に入れない。 */
function mainCards() { return cards.filter(c => (c.pile || 'main') === 'main'); }
function deckSize() { return mainCards().reduce((s, c) => s + c.count, 0); }
function totalOf(pred) { return mainCards().reduce((s, c) => s + (pred(c) ? c.count : 0), 0); }

function handSize() { return D.game(gid).hand; }
function asideSize() { const a = D.game(gid).aside; return a ? a.count : 0; }
function flagA() { return D.game(gid).flagA; }   // ポケカの「たね」。他ゲームは null
function flagB() { return D.game(gid).flagB; }   // ドローソース

/** 現在の条件で「見えている」枚数 = 初手 + ターン中のドロー + 追加ドロー */
function seenCount() {
  const ruleset = $('#ruleset').value;
  const order = $('#turnorder').value;
  const turn = Math.max(1, +$('#turn').value || 1);
  const extra = Math.max(0, +$('#extradraw').value || 0);
  // 先攻がターン1にドローしないルールでは、先攻のドロー回数は turn-1
  const skipFirst = (ruleset === 'nodraw' && order === 'first');
  const turnDraws = Math.max(0, skipFirst ? turn - 1 : turn);
  const cap = Math.max(handSize(), deckSize() - asideSize());
  const seen = Math.min(cap, handSize() + turnDraws + extra);
  return { seen, turnDraws, extra };
}

/* ---------- カード表 ------------------------------------------------------- */

function renderCardTable() {
  const g = D.game(gid);
  const tb = $('#cardtable tbody');
  tb.textContent = '';

  const fa = flagA(), fb = flagB();
  $('#flag-head').innerHTML = fa ? (fa.label + '/<br>' + fb.label) : fb.label;

  cards.forEach((c, i) => {
    const tr = el('tr');
    if ((c.pile || 'main') !== 'main') tr.classList.add('offdeck');

    const tdN = el('td', 'c-n');
    const inN = el('input'); inN.type = 'number'; inN.min = '1'; inN.max = '60';
    inN.value = c.count; inN.inputMode = 'numeric';
    inN.addEventListener('change', () => {
      c.count = Math.max(1, Math.min(60, +inN.value || 1));
      inN.value = c.count; refresh();
    });
    tdN.append(inN); tr.append(tdN);

    const tdName = el('td', 'name');
    tdName.textContent = c.name;
    if ((c.pile || 'main') !== 'main') {
      const tag = el('span', 'pilepin');
      tag.textContent = c.pile === 'extra' ? '別の山' : 'サイド';
      tdName.append(' ', tag);
    }
    tr.append(tdName);

    const tdCat = el('td');
    const sel = el('select');
    for (const cat of g.categories) {
      const o = el('option'); o.value = cat; o.textContent = cat;
      if (cat === c.cat) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      c.cat = sel.value;
      if (fa && !fa.cats.includes(c.cat)) c[fa.key] = false;
      if (fb && !fb.cats.includes(c.cat)) c[fb.key] = false;
      renderCardTable(); refresh();
    });
    tdCat.append(sel); tr.append(tdCat);

    // ゲームによって意味の違うフラグを1列にまとめる。両立することはない。
    const tdF = el('td', 'c-c');
    const which = (fa && fa.cats.includes(c.cat)) ? fa : (fb && fb.cats.includes(c.cat)) ? fb : null;
    if (which) {
      const wrap = el('label', 'flagcell');
      const cb = el('input'); cb.type = 'checkbox';
      cb.checked = !!c[which.key];
      cb.title = which.label;
      cb.addEventListener('change', () => { c[which.key] = cb.checked; refresh(); });
      const cap = el('span', 'flaglab'); cap.textContent = which.label;
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

  const N = deckSize();
  const okSize = N >= g.deckMin && N <= g.deckMax;
  const sum = $('#decksummary');
  sum.textContent = '';
  const chips = [['デッキ ' + N + '枚', okSize ? 'good' : 'bad']];
  for (const cat of g.categories) {
    const n = totalOf(c => c.cat === cat);
    if (n) chips.push([cat + ' ' + n, '']);
  }
  if (flagA()) chips.push([flagA().label + ' ' + totalOf(c => c[flagA().key]), '']);
  const ex = D.countIn(cards, 'extra');
  if (ex) chips.push(['別の山 ' + ex, '']);
  for (const [t, cls] of chips) {
    const s = el('span', 'chip' + (cls ? ' ' + cls : '')); s.textContent = t; sum.append(s);
  }
}

/* ---------- 診断 ----------------------------------------------------------- */

function renderDiagnostics() {
  const g = D.game(gid);
  const N = deckSize();
  const okSize = N >= g.deckMin && N <= g.deckMax;
  const fa = flagA(), fb = flagB();
  const basics = fa ? totalOf(c => c[fa.key]) : 0;
  const draws = fb ? totalOf(c => c[fb.key]) : 0;

  const mull = (fa && okSize) ? 1 - hgAtLeast(N, basics, handSize(), 1) : null;
  const { seen } = seenCount();
  const drawOpen = okSize ? hgAtLeast(N, draws, handSize(), 1) : null;

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

  if (fa) {
    grid.append(stat('マリガン率', mull === null ? '—' : pct(mull), fa.label + ' ' + basics + '枚',
      mull === null ? '' : mull > 0.12 ? 'bad' : mull > 0.08 ? 'warn' : 'good'));
  }
  grid.append(stat('初手に' + (fb ? fb.label : 'ドロー'), drawOpen === null ? '—' : pct(drawOpen),
    (fb ? fb.label : '') + ' ' + draws + '枚', drawOpen === null ? '' : drawOpen < 0.5 ? 'warn' : 'good'));
  grid.append(stat('見えるカード', seen + '枚', '初手' + handSize() + ' + ドロー' + (seen - handSize())));
  grid.append(stat('デッキ枚数', N + '枚',
    okSize ? '' : g.deckMin + (g.deckMax !== g.deckMin ? '〜' + g.deckMax : '') + '枚にしてください',
    okSize ? 'good' : 'bad'));

  const ul = $('#warnings');
  ul.textContent = '';
  const warn = (cls, text) => { const li = el('li', cls); li.textContent = text; ul.append(li); };

  if (!okSize) {
    warn('bad', 'メインデッキが ' + N + '枚です。' + g.label + 'は ' +
      g.deckMin + (g.deckMax !== g.deckMin ? '〜' + g.deckMax : '') + '枚なので、以下の確率は正しくありません。');
  }
  const over = mainCards().filter(c => c.count > g.maxCopies && !D.isUnlimited(c, gid));
  if (over.length) {
    warn('bad', '同名カードが' + g.maxCopies + '枚を超えています: ' +
      over.map(c => c.name + '(' + c.count + ')').join('、'));
  }
  if (fa) {
    if (basics === 0) warn('bad', fa.label + 'が0枚です。ゲームを始められません。種別と「' + fa.label + '」チェックを確認してください。');
    else if (mull !== null && mull > 0.12) warn('bad', 'マリガン率 ' + pct(mull) + ' は高めです。' + fa.label + 'を増やすと安定します。');
    else if (mull !== null && mull > 0.08) warn('warn', 'マリガン率 ' + pct(mull) + '。もう1〜2枚足すと落ち着きます。');
    else if (mull !== null) warn('ok', 'マリガン率 ' + pct(mull) + '。' + fa.label + 'の枚数は十分です。');
  }
  if (fb) {
    if (draws === 0) warn('warn', fb.label + 'ソースが0枚です。該当するカードに「' + fb.label + '」チェックを入れてください。');
    else if (drawOpen !== null && drawOpen < 0.5) {
      warn('warn', '初手に' + fb.label + 'がある確率が ' + pct(drawOpen) + ' しかありません。' + draws + '枚は少なめです。');
    }
  }
  if (!ul.children.length) warn('ok', '目立った問題は見つかりませんでした。');
}

/* ---------- カード別確率 --------------------------------------------------- */

function renderPerCard() {
  const N = deckSize();
  const A = asideSize();
  const { seen } = seenCount();
  const tb = $('#pertable tbody');
  tb.textContent = '';
  // 伏せ札のないゲームでは、その2列ごと消す
  $('#pertable').classList.toggle('no-aside', !A);
  if (A) {
    $('#aside-head').textContent = D.game(gid).aside.name + '落ち';
    $('#asideall-head').textContent = '全落ち';
  }

  const sorted = mainCards().slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  for (const c of sorted) {
    const K = c.count;
    const vals = [
      hgAtLeast(N, K, handSize(), 1),
      hgAtLeast(N, K, seen, 1),
      A ? hgAtLeast(N, K, A, 1) : null,
      A ? hgAtLeast(N, K, A, K) : null,
    ];
    const tr = el('tr');
    const n = el('td', 'name'); n.textContent = c.name + ' ×' + K; tr.append(n);
    for (const v of vals) {
      const td = el('td', 'c-p'); td.textContent = v === null ? '—' : pct(v); tr.append(td);
    }
    tb.append(tr);
  }
}

/* ---------- コンボ確率 (モンテカルロ) --------------------------------------- */

function renderComboList() {
  const box = $('#combolist');
  const prev = {};
  box.querySelectorAll('.combo-row').forEach(r => {
    prev[r.dataset.name] = { on: r.querySelector('input[type=checkbox]').checked, need: +r.querySelector('.cneed').value };
  });
  box.textContent = '';

  for (const c of mainCards()) {
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
  const list = mainCards();
  document.querySelectorAll('#combolist .combo-row').forEach(r => {
    if (!r.querySelector('input[type=checkbox]').checked) return;
    const c = list.find(x => x.name === r.dataset.name);
    if (!c) return;
    const need = Math.max(1, Math.min(c.count, +r.querySelector('.cneed').value || 1));
    out.push({ card: c, need });
  });
  return out;
}

/**
 * 山札を実際に混ぜて数える。
 * 先頭が初手、次が伏せ札、その後ろから順にドロー。
 * マリガンのあるゲームでは、条件を満たすまで引き直す。
 */
function simulateCombo(targets, seen, trials) {
  const list = mainCards();
  const N = list.reduce((s, c) => s + c.count, 0);
  const H = handSize(), A = asideSize();
  const fa = flagA();
  const idxOf = new Map(targets.map(t => [list.indexOf(t.card), t.need]));

  // 各カードを「対象なら添字、そうでなければ -1」に潰し、下位1bitに たね を入れる
  const pair = [];
  list.forEach((c, i) => {
    const id = idxOf.has(i) ? i : -1;
    const isA = fa ? !!c[fa.key] : false;
    for (let k = 0; k < c.count; k++) pair.push(isA ? id * 2 + 1 : id * 2);
  });

  const anyBasic = fa ? list.some(c => c[fa.key]) : false;
  const counts = new Int32Array(list.length);
  let hits = 0, mulliganTrials = 0;

  for (let t = 0; t < trials; t++) {
    D.shuffle(pair);

    let hadMulligan = false;
    if (fa && anyBasic) {
      for (let guard = 0; guard < 100; guard++) {
        let ok = false;
        for (let i = 0; i < H; i++) if (pair[i] & 1) { ok = true; break; }
        if (ok) break;
        hadMulligan = true;
        D.shuffle(pair);
      }
    }
    if (hadMulligan) mulliganTrials++;

    counts.fill(0);
    for (let i = 0; i < H; i++) { const id = pair[i] >> 1; if (id >= 0) counts[id]++; }
    const drawn = Math.max(0, seen - H);
    for (let i = 0; i < drawn; i++) {
      const p = pair[H + A + i];
      if (p === undefined) break;
      const id = p >> 1; if (id >= 0) counts[id]++;
    }

    let ok = true;
    for (const [i, need] of idxOf) if (counts[i] < need) { ok = false; break; }
    if (ok) hits++;
  }

  const p = hits / trials;
  return { p, se: Math.sqrt(Math.max(p * (1 - p), 1e-12) / trials), mulliganRate: mulliganTrials / trials };
}

function runCombo() {
  const g = D.game(gid);
  const box = $('#comboresult');
  box.textContent = '';
  const say = t => { const p = el('p', 'hint'); p.textContent = t; box.append(p); };

  const targets = readComboTargets();
  if (!targets.length) return say('カードを1枚以上選んでください。');
  const N = deckSize();
  if (N < g.deckMin || N > g.deckMax) return say('メインデッキの枚数が合っていないため計算できません(現在 ' + N + '枚)。');
  if (flagA() && totalOf(c => c[flagA().key]) === 0) {
    return say(flagA().label + 'が0枚だとゲームが成立しないため計算できません。');
  }

  const { seen } = seenCount();
  const r = simulateCombo(targets, seen, TRIALS);

  const wrap = el('div', 'bigresult');
  const lab = el('span', 'lab');
  lab.textContent = targets.map(t => t.card.name + (t.need > 1 ? '×' + t.need : '')).join(' + ') + ' が揃う確率';
  const val = el('span', 'val'); val.textContent = pct(r.p);
  const ci = el('span', 'ci');
  ci.textContent = '95%信頼区間 ±' + (r.se * 1.96 * 100).toFixed(2) + 'pt / ' +
    TRIALS.toLocaleString() + '回試行 / 見えるカード ' + seen + '枚' +
    (flagA() ? ' / マリガン率 ' + pct(r.mulliganRate) : '');
  wrap.append(lab, val, ci);
  box.append(wrap);
}

/* ---------- 採用枚数の比較 -------------------------------------------------- */

function renderCountCompare() {
  const sel = $('#countcard');
  const keep = sel.value;
  const list = mainCards();
  sel.textContent = '';
  list.forEach(c => {
    const o = el('option'); o.value = c.name; o.textContent = c.name + '(現在 ' + c.count + '枚)';
    sel.append(o);
  });
  if (keep && list.some(c => c.name === keep)) sel.value = keep;

  const target = list.find(c => c.name === sel.value);
  $('#counttable').classList.toggle('no-aside', !asideSize());
  const tb = $('#counttable tbody');
  tb.textContent = '';
  if (!target) return;

  const N = deckSize(), A = asideSize();
  const { seen } = seenCount();
  const maxK = Math.max(D.game(gid).maxCopies, target.count);
  for (let k = 1; k <= maxK; k++) {
    const tr = el('tr');
    if (k === target.count) tr.style.fontWeight = '700';
    const c0 = el('td'); c0.textContent = k + '枚' + (k === target.count ? '(現在)' : '');
    tr.append(c0);
    const vals = [
      hgAtLeast(N, k, handSize(), 1),
      hgAtLeast(N, k, seen, 1),
      A ? hgAtLeast(N, k, A, k) : null,
    ];
    for (const v of vals) { const td = el('td', 'c-p'); td.textContent = v === null ? '—' : pct(v); tr.append(td); }
    tb.append(tr);
  }
}

/* ---------- まとめ --------------------------------------------------------- */

function updateSeenLabel() {
  const { seen, turnDraws, extra } = seenCount();
  const A = asideSize();
  $('#seencount').textContent = seen;
  $('#seenbreak').textContent =
    '内訳: 初手 ' + handSize() + ' + ターンドロー ' + turnDraws + ' + 追加ドロー ' + extra +
    (A ? '(' + D.game(gid).aside.name + ' ' + A + '枚は引けない前提)' : '');
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

function save() {
  D.saveDeck(gid, $('#decklist').value, cards);
  try {
    localStorage.setItem(KEY_LAB, JSON.stringify({
      ruleset: $('#ruleset').value, turnorder: $('#turnorder').value,
      turn: $('#turn').value, extradraw: $('#extradraw').value,
    }));
  } catch (e) { /* 保存できなくても計算には支障がない */ }
}

function loadSettings() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY_LAB) || 'null');
    if (!d) return;
    if (d.ruleset) $('#ruleset').value = d.ruleset;
    if (d.turnorder) $('#turnorder').value = d.turnorder;
    if (d.turn) $('#turn').value = d.turn;
    if (d.extradraw) $('#extradraw').value = d.extradraw;
  } catch (e) { /* 壊れていたら既定値で始める */ }
}

/* ---------- サンプル ------------------------------------------------------- */

const SAMPLES = {
  pokemon: `ポケモン 13
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
4 特殊エネルギーB`,

  duelmasters: `クリーチャー 24
4 軽量クリーチャーA
4 中量クリーチャーB
4 フィニッシャーC
4 ブロッカーD
4 マナ加速クリーチャーE
4 除去クリーチャーF

呪文 16
4 ドロー呪文G
4 除去呪文H
4 マナ加速呪文I
4 防御呪文J`,

  yugioh: `モンスター 18
3 展開モンスターA
3 誘発モンスターB
3 初動モンスターC
3 手札誘発D
3 上級モンスターE
3 チューナーF

魔法 16
3 サーチ魔法G
3 展開魔法H
3 除去魔法I
3 墓地肥やし魔法J
2 制限魔法K
2 フィールド魔法L

罠 6
3 妨害罠M
3 永続罠N`,
};

/* ---------- 起動 ----------------------------------------------------------- */

function applyGameToUI() {
  const g = D.game(gid);
  $('#ruleset').value = g.firstTurnNoDraw ? 'nodraw' : 'draw';
}

function boot() {
  const gsel = $('#game');
  D.GAME_IDS.forEach(id => {
    const o = el('option'); o.value = id; o.textContent = D.GAMES[id].label; gsel.append(o);
  });

  loadSettings();
  const saved = D.loadDeck();
  if (saved) { gid = saved.game; $('#decklist').value = saved.text; cards = saved.cards; }
  gsel.value = gid;

  gsel.addEventListener('change', () => {
    gid = gsel.value;
    applyGameToUI();
    if ($('#decklist').value.trim()) cards = D.parseDeck($('#decklist').value, gid);
    renderAll();
  });

  $('#btn-parse').addEventListener('click', () => {
    const parsed = D.parseDeck($('#decklist').value, gid);
    if (!parsed.length) { alert('カードを読み取れませんでした。「4 カード名」の形式で入力してください。'); return; }
    cards = parsed;
    renderAll();
    $('#sec-cards').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#btn-sample').addEventListener('click', () => {
    $('#decklist').value = SAMPLES[gid] || '';
    cards = D.parseDeck($('#decklist').value, gid);
    renderAll();
    $('#sec-cards').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#btn-clear').addEventListener('click', () => {
    $('#decklist').value = ''; cards = []; renderAll();
    D.clearDeck();
  });

  for (const id of ['#ruleset', '#turnorder', '#turn', '#extradraw']) {
    $(id).addEventListener('change', refresh);
    $(id).addEventListener('input', refresh);
  }
  $('#countcard').addEventListener('change', renderCountCompare);
  $('#btn-combo').addEventListener('click', runCombo);

  if (cards.length) renderAll(); else updateSeenLabel();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}

document.addEventListener('DOMContentLoaded', boot);
