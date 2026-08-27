'use strict';

/* =========================================================================
   solo.js — 一人回し
   カードの効果は解決しない。ゾーンの管理・シャッフル・ドローだけを引き受け、
   何をどこに動かすかは人間が決める。実物のプレイマットの代わり。
   ========================================================================= */

const D = window.DeckLib;
const $ = s => document.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

const KEY_SOLO = 'tcg-solo-v1';
const UNDO_MAX = 40;

/* ---------- 状態 ---------------------------------------------------------- */

let gid = D.DEFAULT_GAME;
let cards = [];          // 解析済みのデッキ (枚数つき)
let cfg = null;          // 画面で編集したルール
let S = null;            // 盤面
let undoStack = [];
let records = [];
let revealAside = false;

function blankBoard() {
  const piles = { deck: [], hand: [], discard: [], aside: [], extra: [] };
  for (const z of cfg.zones) piles[z.id] = [];
  return { piles, turn: 0, mulligans: 0, started: false, log: [] };
}

/** 表示名つきのパイル定義を並べる (ゾーンシートの移動先に使う) */
function pileDefs() {
  const g = D.game(gid);
  const out = [
    { id: 'hand', name: '手札' },
    ...cfg.zones.map(z => ({ id: z.id, name: z.name, max: z.max })),
    { id: 'discard', name: g.discardName },
  ];
  if (cfg.aside && cfg.aside.count > 0) out.push({ id: 'aside', name: cfg.aside.name });
  if (g.extra) out.push({ id: 'extra', name: g.extra.name });
  return out;
}

function pileName(id) {
  if (id === 'deck') return D.game(gid).deckName;
  const d = pileDefs().find(p => p.id === id);
  return d ? d.name : id;
}

/* ---------- 履歴 ----------------------------------------------------------- */

function snapshot() {
  undoStack.push(JSON.stringify({ piles: S.piles, turn: S.turn, mulligans: S.mulligans, log: S.log }));
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}
function undo() {
  const prev = undoStack.pop();
  if (!prev) { toast('これ以上は戻せません'); return; }
  const d = JSON.parse(prev);
  S.piles = d.piles; S.turn = d.turn; S.mulligans = d.mulligans; S.log = d.log;
  render();
}
function logAdd(text) {
  S.log.unshift({ turn: S.turn, text });
  if (S.log.length > 200) S.log.pop();
}

/* ---------- セットアップ --------------------------------------------------- */

function startGame() {
  S = blankBoard();
  S.started = true;
  undoStack = [];

  S.piles.deck = D.shuffle(D.materialize(cards, 'main'));
  S.piles.extra = D.materialize(cards, 'extra');

  const opening = D.dealOpening(S.piles.deck, cfg.hand, cfg.mulligan);
  S.piles.hand = opening.hand;
  S.mulligans = opening.mulligans;

  if (cfg.aside && cfg.aside.count > 0) {
    S.piles.aside = S.piles.deck.splice(0, cfg.aside.count);
  }

  S.turn = 1;
  revealAside = false;
  logAdd('ゲーム開始。初手' + S.piles.hand.length + '枚' +
         (S.mulligans ? ' (マリガン' + S.mulligans + '回)' : ''));
  render();
}

/* ---------- 操作 ----------------------------------------------------------- */

function draw(n) {
  if (!S.piles.deck.length) { toast(D.game(gid).deckName + 'が0枚です'); return; }
  snapshot();
  const got = S.piles.deck.splice(0, Math.min(n, S.piles.deck.length));
  S.piles.hand.push(...got);
  logAdd(got.length + '枚ドロー: ' + got.map(c => c.name).join('、'));
  render();
}

function endTurn() {
  snapshot();
  S.turn++;
  const skip = (S.turn === 1 && cfg.firstTurnNoDraw);
  if (!skip && S.piles.deck.length) {
    const c = S.piles.deck.shift();
    S.piles.hand.push(c);
    logAdd('ターン' + S.turn + '開始。ドロー: ' + c.name);
  } else {
    logAdd('ターン' + S.turn + '開始' + (skip ? ' (先攻のためドローなし)' : ''));
  }
  render();
}

function shuffleDeck(silent) {
  snapshot();
  D.shuffle(S.piles.deck);
  if (!silent) logAdd(D.game(gid).deckName + 'をシャッフル');
  render();
}

function mulliganShrink() {
  snapshot();
  S.piles.deck = D.shuffle(S.piles.deck.concat(S.piles.hand, S.piles.aside));
  S.piles.aside = [];
  S.mulligans++;
  const size = Math.max(0, cfg.hand - S.mulligans);
  S.piles.hand = S.piles.deck.splice(0, size);
  if (cfg.aside && cfg.aside.count > 0) S.piles.aside = S.piles.deck.splice(0, cfg.aside.count);
  logAdd('マリガン' + S.mulligans + '回目。初手' + size + '枚で引き直し');
  render();
}

function move(uid, from, to, opts) {
  opts = opts || {};
  const src = S.piles[from];
  const i = src.findIndex(c => c.uid === uid);
  if (i < 0) return;

  const dest = pileDefs().find(p => p.id === to);
  if (dest && dest.max > 0 && S.piles[to].length >= dest.max) {
    toast(dest.name + 'は' + dest.max + '枚までです');
    return;
  }
  snapshot();
  const [c] = src.splice(i, 1);
  if (to === 'deck') {
    if (opts.bottom) S.piles.deck.push(c); else S.piles.deck.unshift(c);
    logAdd(c.name + ' → ' + D.game(gid).deckName + (opts.bottom ? 'の下' : 'の上'));
  } else {
    S.piles[to].push(c);
    logAdd(c.name + ' → ' + pileName(to));
  }
  render();
}

/* ---------- 描画 ----------------------------------------------------------- */

const CAT_CLASS = {
  'ポケモン': 'c1', 'クリーチャー': 'c1', 'モンスター': 'c1',
  'サポート': 'c2', '呪文': 'c2', '魔法': 'c2',
  'グッズ': 'c3', '罠': 'c3', 'その他': 'c3',
  'どうぐ': 'c4', 'スタジアム': 'c5', 'エネルギー': 'c6',
};

function cardChip(c, from, faceDown) {
  const b = el('button', 'chipcard ' + (CAT_CLASS[c.cat] || 'c3'));
  if (faceDown) {
    b.classList.add('facedown');
    b.textContent = '?';
    b.setAttribute('aria-label', '裏向きのカード');
  } else {
    b.textContent = c.name;
    b.title = c.name + ' / ' + c.cat;
  }
  b.addEventListener('click', () => openSheet(c, from, faceDown));
  return b;
}

function renderStatus() {
  const g = D.game(gid);
  const bar = $('#statusbar');
  bar.textContent = '';
  const item = (lab, val, cls) => {
    const d = el('div', 'st' + (cls ? ' ' + cls : ''));
    const l = el('span', 'l'); l.textContent = lab;
    const v = el('span', 'v'); v.textContent = val;
    d.append(l, v); return d;
  };
  bar.append(item('ターン', S.turn));
  bar.append(item(g.deckName, S.piles.deck.length, S.piles.deck.length === 0 ? 'bad' : ''));
  bar.append(item(g.discardName, S.piles.discard.length));
  if (S.mulligans) bar.append(item('マリガン', S.mulligans, 'bad'));
}

function renderZones() {
  const g = D.game(gid);
  const box = $('#zones');
  box.textContent = '';

  const zone = (id, name, list, max, faceDown, extraBtn) => {
    const d = el('div', 'zone');
    const h = el('div', 'zonehead');
    const n = el('span', 'zname'); n.textContent = name;
    const c = el('span', 'zcount');
    c.textContent = list.length + (max > 0 ? ' / ' + max : '');
    h.append(n, c);
    if (extraBtn) h.append(extraBtn);
    const g2 = el('div', 'cardgrid');
    if (!list.length) { const e = el('span', 'empty'); e.textContent = '—'; g2.append(e); }
    else list.forEach(cd => g2.append(cardChip(cd, id, faceDown)));
    d.append(h, g2);
    return d;
  };

  for (const z of cfg.zones) box.append(zone(z.id, z.name, S.piles[z.id], z.max, false));

  if (cfg.aside && cfg.aside.count > 0) {
    const btn = el('button', 'minibtn');
    btn.textContent = revealAside ? '隠す' : '中身を見る';
    btn.addEventListener('click', () => { revealAside = !revealAside; render(); });
    box.append(zone('aside', cfg.aside.name, S.piles.aside, 0, !revealAside, btn));
  }
  if (g.extra) box.append(zone('extra', g.extra.name, S.piles.extra, 0, false));
  box.append(zone('discard', g.discardName, S.piles.discard, 0, false));
}

function renderHand() {
  const box = $('#hand');
  box.textContent = '';
  $('#hand-count').textContent = S.piles.hand.length;
  if (!S.piles.hand.length) { const e = el('span', 'empty'); e.textContent = '手札なし'; box.append(e); return; }
  S.piles.hand.forEach(c => box.append(cardChip(c, 'hand', false)));
}

function renderLog() {
  const ol = $('#log');
  ol.textContent = '';
  S.log.slice(0, 40).forEach(entry => {
    const li = el('li');
    const t = el('span', 'lt'); t.textContent = 'T' + entry.turn;
    const x = el('span'); x.textContent = entry.text;
    li.append(t, x); ol.append(li);
  });
}

function render() {
  const on = !!(S && S.started);
  for (const id of ['sec-board', 'sec-record', 'sec-log']) $('#' + id).classList.toggle('hidden', !on);
  $('#actionbar').classList.toggle('hidden', !on);
  // 「引き直すたび1枚減る」ルールのときだけ、専用のボタンを出す
  $('#a-mull').classList.toggle('hidden', !(on && cfg.mulligan === 'shrink'));
  document.body.classList.toggle('has-bar', on);
  if (!on) return;
  renderStatus(); renderZones(); renderHand(); renderLog(); renderRecords();
  saveSolo();
}

/* ---------- カード移動シート ------------------------------------------------ */

function openSheet(card, from, faceDown) {
  $('#sheet-title').textContent = faceDown ? '裏向きのカード' : card.name;
  const box = $('#sheet-actions');
  box.textContent = '';

  const add = (label, fn, cls) => {
    const b = el('button', cls || '');
    b.textContent = label;
    b.addEventListener('click', () => { closeSheet(); fn(); });
    box.append(b);
  };

  for (const p of pileDefs()) {
    if (p.id === from) continue;
    add(p.name + 'へ', () => move(card.uid, from, p.id));
  }
  add(D.game(gid).deckName + 'の上へ', () => move(card.uid, from, 'deck', { bottom: false }));
  add(D.game(gid).deckName + 'の下へ', () => move(card.uid, from, 'deck', { bottom: true }));

  $('#sheet-bg').classList.remove('hidden');
}
function closeSheet() { $('#sheet-bg').classList.add('hidden'); }

/* ---------- 山札を見る ------------------------------------------------------ */

function openDeckSheet() {
  const g = D.game(gid);
  $('#deck-title').textContent = g.deckName + 'の中身 (' + S.piles.deck.length + '枚)';
  $('#deck-note').textContent = 'サーチのつもりで選びます。閉じると自動でシャッフルします。';
  const box = $('#deck-list');
  box.textContent = '';

  // 中身は並べ替えて見せる。山札の順番を悟られないようにするため。
  const sorted = S.piles.deck.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (!sorted.length) { const e = el('span', 'empty'); e.textContent = '空です'; box.append(e); }
  sorted.forEach(c => {
    const b = el('button', 'chipcard ' + (CAT_CLASS[c.cat] || 'c3'));
    b.textContent = c.name;
    b.addEventListener('click', () => {
      snapshot();
      const i = S.piles.deck.findIndex(x => x.uid === c.uid);
      if (i >= 0) { S.piles.hand.push(S.piles.deck.splice(i, 1)[0]); logAdd('サーチ: ' + c.name); }
      render(); openDeckSheet();
    });
    box.append(b);
  });
  $('#deck-bg').classList.remove('hidden');
}
function closeDeckSheet() {
  $('#deck-bg').classList.add('hidden');
  if (S && S.started) { D.shuffle(S.piles.deck); logAdd(D.game(gid).deckName + 'をシャッフル'); render(); }
}

/* ---------- 記録 ----------------------------------------------------------- */

function addRecord(ok) {
  records.push({ ok, turn: S.turn, mull: S.mulligans });
  saveSolo();
  renderRecords();
  toast(ok ? 'まわった として記録しました' : 'まわらなかった として記録しました');
}

function renderRecords() {
  const box = $('#records');
  box.textContent = '';
  const stat = (lab, val, note) => {
    const d = el('div', 'stat');
    const l = el('span', 'lab'); l.textContent = lab;
    const v = el('span', 'val'); v.textContent = val;
    d.append(l, v);
    if (note) { const n = el('span', 'note'); n.textContent = note; d.append(n); }
    return d;
  };
  const n = records.length;
  if (!n) { box.append(stat('試行', '0', 'まだ記録がありません')); return; }
  const ok = records.filter(r => r.ok).length;
  const avgMull = records.reduce((s, r) => s + r.mull, 0) / n;
  const okTurns = records.filter(r => r.ok);
  const avgTurn = okTurns.length ? okTurns.reduce((s, r) => s + r.turn, 0) / okTurns.length : null;

  box.append(stat('試行', n + '回'));
  box.append(stat('成功率', (ok / n * 100).toFixed(0) + '%', ok + ' / ' + n));
  box.append(stat('平均マリガン', avgMull.toFixed(2) + '回'));
  box.append(stat('成功時の平均ターン', avgTurn === null ? '—' : avgTurn.toFixed(1)));
}

/* ---------- 保存 ----------------------------------------------------------- */

function saveSolo() {
  try {
    localStorage.setItem(KEY_SOLO, JSON.stringify({ gid, cfg, records }));
  } catch (e) { /* 保存できなくても動作には支障がない */ }
}
function loadSolo() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY_SOLO) || 'null');
    if (!d) return;
    if (d.gid && D.GAMES[d.gid]) gid = d.gid;
    if (Array.isArray(d.records)) records = d.records;
    if (d.cfg) cfg = d.cfg;
  } catch (e) { /* 壊れていたら既定値で始める */ }
}

/* ---------- ルール欄 -------------------------------------------------------- */

function cfgFromGame(id) {
  const g = D.game(id);
  return {
    hand: g.hand,
    mulligan: g.mulligan,
    firstTurnNoDraw: g.firstTurnNoDraw,
    aside: g.aside ? { id: 'aside', name: g.aside.name, count: g.aside.count } : null,
    zones: g.zones.map(z => ({ ...z })),
  };
}

function syncRuleInputs() {
  $('#r-hand').value = cfg.hand;
  $('#r-aside').value = cfg.aside ? cfg.aside.count : 0;
  $('#r-aside-lab').textContent = cfg.aside ? cfg.aside.name : '伏せ札';
  $('#r-mulligan').value = cfg.mulligan;
  $('#r-firstdraw').value = cfg.firstTurnNoDraw ? 'nodraw' : 'draw';
}

function readRuleInputs() {
  cfg.hand = Math.max(1, Math.min(20, +$('#r-hand').value || 1));
  const ac = Math.max(0, Math.min(12, +$('#r-aside').value || 0));
  if (cfg.aside) cfg.aside.count = ac;
  else if (ac > 0) cfg.aside = { id: 'aside', name: '伏せ札', count: ac };
  cfg.mulligan = $('#r-mulligan').value;
  cfg.firstTurnNoDraw = $('#r-firstdraw').value === 'nodraw';
  saveSolo();
}

function updateSetupHint() {
  const g = D.game(gid);
  const main = D.countIn(cards, 'main');
  const extra = D.countIn(cards, 'extra');
  const parts = [];
  parts.push('デッキ ' + g.deckMin + (g.deckMax !== g.deckMin ? '〜' + g.deckMax : '') + '枚 / 初手 ' + cfg.hand + '枚');
  if (cfg.aside && cfg.aside.count) parts.push(cfg.aside.name + ' ' + cfg.aside.count + '枚');
  if (g.extra) parts.push(g.extra.name + 'は「' + (gid === 'yugioh' ? 'エクストラデッキ' : '超次元') + '」の見出しの下に書くと別の山になります');
  let s = parts.join(' / ');
  if (cards.length) {
    s += ' — 読み込み済み: ' + main + '枚' + (extra ? ' + 別の山 ' + extra + '枚' : '');
    if (main < g.deckMin || main > g.deckMax) s += ' ⚠ 枚数が合っていません';
  }
  $('#setup-hint').textContent = s;
}

/* ---------- サンプル -------------------------------------------------------- */

const SAMPLES = {
  pokemon: `ポケモン 12
4 たねポケモンA
3 たねポケモンB
2 進化ポケモンB1
3 たねポケモンC

トレーナー 33
4 博士の研究
4 ナンジャモ
2 ボスの指令
4 ネストボール
4 ハイパーボール
3 なかよしポフィン
3 すごいつりざお
3 ポケモンのどうぐA
3 スタジアムA
3 ふしぎなアメ

エネルギー 15
11 基本エネルギーA
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
4 防御呪文J

超次元
4 サイキックK
4 GRクリーチャーL`,

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
3 永続罠N

エクストラデッキ
3 融合モンスターO
3 シンクロモンスターP
3 エクシーズモンスターQ
3 リンクモンスターR
3 汎用リンクS`,
};

/* ---------- こまごま -------------------------------------------------------- */

let toastTimer = null;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = el('div'); t.id = 'toast'; t.className = 'toast'; document.body.append(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
}

function loadDeckFromText() {
  const parsed = D.parseDeck($('#decklist').value, gid);
  if (!parsed.length) { toast('カードを読み取れませんでした'); return false; }
  cards = parsed;
  D.saveDeck(gid, $('#decklist').value, cards);
  updateSetupHint();
  return true;
}

/* ---------- 起動 ----------------------------------------------------------- */

function boot() {
  const sel = $('#game');
  D.GAME_IDS.forEach(id => {
    const o = el('option'); o.value = id; o.textContent = D.GAMES[id].label; sel.append(o);
  });

  loadSolo();
  const saved = D.loadDeck();
  if (saved) { gid = saved.game; $('#decklist').value = saved.text; cards = saved.cards; }
  if (!cfg || !cfg.zones) cfg = cfgFromGame(gid);
  sel.value = gid;
  syncRuleInputs();
  updateSetupHint();

  sel.addEventListener('change', () => {
    gid = sel.value;
    cfg = cfgFromGame(gid);
    syncRuleInputs();
    if ($('#decklist').value.trim()) cards = D.parseDeck($('#decklist').value, gid);
    updateSetupHint();
    saveSolo();
  });

  for (const id of ['#r-hand', '#r-aside', '#r-mulligan', '#r-firstdraw']) {
    $(id).addEventListener('change', () => { readRuleInputs(); updateSetupHint(); });
  }

  $('#btn-load').addEventListener('click', () => { if (loadDeckFromText()) startGame(); });
  $('#btn-sample').addEventListener('click', () => {
    $('#decklist').value = SAMPLES[gid] || '';
    if (loadDeckFromText()) startGame();
  });

  $('#a-draw').addEventListener('click', () => draw(1));
  $('#a-search').addEventListener('click', openDeckSheet);
  $('#a-shuffle').addEventListener('click', () => shuffleDeck(false));
  $('#a-end').addEventListener('click', endTurn);
  $('#a-undo').addEventListener('click', undo);
  $('#a-restart').addEventListener('click', startGame);
  $('#a-mull').addEventListener('click', mulliganShrink);

  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-bg').addEventListener('click', e => { if (e.target.id === 'sheet-bg') closeSheet(); });
  $('#deck-close').addEventListener('click', closeDeckSheet);
  $('#deck-bg').addEventListener('click', e => { if (e.target.id === 'deck-bg') closeDeckSheet(); });

  $('#btn-ok').addEventListener('click', () => addRecord(true));
  $('#btn-ng').addEventListener('click', () => addRecord(false));
  $('#btn-reset-rec').addEventListener('click', () => {
    if (!records.length) return;
    records = []; saveSolo(); renderRecords(); toast('記録を消しました');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSheet(); $('#deck-bg').classList.add('hidden'); }
  });

  renderRecords();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}

document.addEventListener('DOMContentLoaded', boot);
