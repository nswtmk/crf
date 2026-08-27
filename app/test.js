/* =========================================================================
   test.js — 確率計算とデッキ解析の検証
   実行:  node test.js
   ========================================================================= */
const fs = require('fs'), vm = require('vm');
const dir = __dirname + '/';

const noop = () => {};
const stub = { addEventListener: noop, append: noop, textContent: '', value: '',
               classList: { toggle: noop, add: noop, remove: noop },
               querySelectorAll: () => [], querySelector: () => stub, style: {}, dataset: {} };
const ctx = {
  console,
  document: { addEventListener: noop, querySelector: () => stub, querySelectorAll: () => [],
              createElement: () => Object.create(stub) },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  navigator: {}, alert: noop,
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dir + 'deck.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(dir + 'app.js', 'utf8') +
  '\nglobalThis.__T = { hgPMF, hgAtLeast, logC, simulateCombo, deckSize, handSize, asideSize,' +
  ' setState: (g, c) => { gid = g; cards = c; } };', ctx);
const D = ctx.DeckLib, T = ctx.__T;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (e ? '  ' + e : '')); };
const close = (a, b, tol) => Math.abs(a - b) < tol;
const head = t => console.log('\n=== ' + t + ' ===');

/* ---------------------------------------------------------------- 超幾何 */
head('超幾何分布: 手計算との突き合わせ');
const exact4 = 1 - (53 * 52 * 51 * 50) / (60 * 59 * 58 * 57);
ok('60枚中4枚積みが初手7枚に来る = ' + (exact4 * 100).toFixed(4) + '%',
   close(T.hgAtLeast(60, 4, 7, 1), exact4, 1e-12));
ok('60枚中1枚積みが初手7枚 = 7/60', close(T.hgAtLeast(60, 1, 7, 1), 7 / 60, 1e-12));
ok('60枚中1枚積みのサイド落ち = 10%', close(T.hgAtLeast(60, 1, 6, 1), 0.1, 1e-12));
ok('40枚中3枚積みが初手5枚に来る',
   close(T.hgAtLeast(40, 3, 5, 1), 1 - (35 * 34 * 33) / (40 * 39 * 38), 1e-12),
   (T.hgAtLeast(40, 3, 5, 1) * 100).toFixed(2) + '%');
let s = 0; for (let x = 0; x <= 4; x++) s += T.hgPMF(60, 4, 7, x);
ok('PMFの総和 = 1', close(s, 1, 1e-12));
ok('logC(60,30) が正しい (2^53超)', close(T.logC(60, 30), Math.log(118264581564861424), 1e-9));

head('超幾何分布 vs 総当たりシミュレーション');
function brute(N, K, n, trials) {
  let hit = 0;
  for (let t = 0; t < trials; t++) {
    const d = new Array(N).fill(0); for (let i = 0; i < K; i++) d[i] = 1;
    for (let i = N - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const q = d[i]; d[i] = d[j]; d[j] = q; }
    let c = 0; for (let i = 0; i < n; i++) c += d[i];
    if (c >= 1) hit++;
  }
  return hit / trials;
}
for (const [N, K, n] of [[60, 4, 7], [60, 2, 7], [60, 1, 13], [40, 3, 5], [40, 8, 12]]) {
  const e = T.hgAtLeast(N, K, n, 1), m = brute(N, K, n, 200000);
  ok(`N=${N} K=${K} n=${n}: 理論 ${(e * 100).toFixed(2)}% / 実測 ${(m * 100).toFixed(2)}%`, close(e, m, 0.006));
}

head('マリガン率 (ポケカ)');
for (const B of [8, 10, 12, 15]) console.log(`  たね${B}枚 → ${((1 - T.hgAtLeast(60, B, 7, 1)) * 100).toFixed(2)}%`);
ok('たねが多いほど下がる', (1 - T.hgAtLeast(60, 8, 7, 1)) > (1 - T.hgAtLeast(60, 12, 7, 1)));
ok('たね0枚 → 100%', close(1 - T.hgAtLeast(60, 0, 7, 1), 1, 1e-12));

/* ------------------------------------------------ シミュレーションの一致 */
head('シミュレーションが理論値と一致するか (ポケカ 60枚)');
const pk = [
  { name: 'A', count: 4, cat: 'ポケモン', basic: true,  draw: false, pile: 'main' },
  { name: 'B', count: 2, cat: 'グッズ',   basic: false, draw: false, pile: 'main' },
  { name: 'たね埋め', count: 20, cat: 'ポケモン', basic: true, draw: false, pile: 'main' },
  { name: '埋め', count: 34, cat: 'グッズ', basic: false, draw: false, pile: 'main' },
];
T.setState('pokemon', pk);
ok('デッキ枚数を60と認識', T.deckSize() === 60);
ok('初手7・サイド6を認識', T.handSize() === 7 && T.asideSize() === 6);
for (const seen of [7, 13, 20]) {
  const r = T.simulateCombo([{ card: pk[1], need: 1 }], seen, 200000);
  const e = T.hgAtLeast(60, 2, seen, 1);
  ok(`単独カード seen=${seen}: 理論 ${(e * 100).toFixed(2)}% / sim ${(r.p * 100).toFixed(2)}%`, close(e, r.p, 0.006));
}
function comboExact(N, K1, n1, K2, n2, n) {
  let t = 0;
  for (let a = n1; a <= Math.min(K1, n); a++)
    for (let b = n2; b <= Math.min(K2, n - a); b++)
      t += Math.exp(T.logC(K1, a) + T.logC(K2, b) + T.logC(N - K1 - K2, n - a - b) - T.logC(N, n));
  return t;
}
{
  const r = T.simulateCombo([{ card: pk[0], need: 1 }, { card: pk[1], need: 1 }], 13, 300000);
  const e = comboExact(60, 4, 1, 2, 1, 13);
  ok(`2枚コンボ seen=13: 理論 ${(e * 100).toFixed(2)}% / sim ${(r.p * 100).toFixed(2)}%`, close(e, r.p, 0.007));
}
{
  const r = T.simulateCombo([{ card: pk[0], need: 2 }], 20, 300000);
  const e = T.hgAtLeast(60, 4, 20, 2);
  ok(`同名2枚要求 seen=20: 理論 ${(e * 100).toFixed(2)}% / sim ${(r.p * 100).toFixed(2)}%`, close(e, r.p, 0.007));
}

head('遊戯王 40枚 — デッキ枚数がちゃんと効いているか');
const yg = [
  { name: '初動', count: 3, cat: 'モンスター', draw: false, pile: 'main' },
  { name: '埋め', count: 37, cat: 'モンスター', draw: false, pile: 'main' },
  { name: '融合', count: 5, cat: 'モンスター', draw: false, pile: 'extra' },
];
T.setState('yugioh', yg);
ok('メインだけ数えて40枚 (エクストラを含めない)', T.deckSize() === 40, '→ ' + T.deckSize());
ok('初手5・伏せ札なし', T.handSize() === 5 && T.asideSize() === 0);
{
  const r = T.simulateCombo([{ card: yg[0], need: 1 }], 5, 300000);
  const e = T.hgAtLeast(40, 3, 5, 1);
  ok(`初動3枚が初手5枚に: 理論 ${(e * 100).toFixed(2)}% / sim ${(r.p * 100).toFixed(2)}%`, close(e, r.p, 0.007));
  ok('マリガンのないゲームでは引き直しが起きない', r.mulliganRate === 0);
}

head('デュエマ 40枚 — シールド5枚を引けない扱いにしているか');
const dm = [
  { name: 'キーカード', count: 4, cat: 'クリーチャー', draw: false, pile: 'main' },
  { name: '埋め', count: 36, cat: '呪文', draw: false, pile: 'main' },
];
T.setState('duelmasters', dm);
ok('デッキ40枚・初手5・シールド5', T.deckSize() === 40 && T.handSize() === 5 && T.asideSize() === 5);
{
  // 40枚すべて見ようとしても、シールド5枚は引けないので上限は35枚
  const r = T.simulateCombo([{ card: dm[0], need: 4 }], 35, 100000);
  const e = T.hgAtLeast(40, 4, 35, 4);
  ok(`4枚すべてを35枚で: 理論 ${(e * 100).toFixed(2)}% / sim ${(r.p * 100).toFixed(2)}%`, close(e, r.p, 0.008));
}

head('マリガンの引き直しが効いているか');
{
  const d2 = [
    { name: 'A', count: 4, cat: 'ポケモン', basic: true, draw: false, pile: 'main' },
    { name: '埋め', count: 56, cat: 'グッズ', basic: false, draw: false, pile: 'main' },
  ];
  T.setState('pokemon', d2);
  const r = T.simulateCombo([{ card: d2[0], need: 1 }], 7, 100000);
  ok('唯一のたねは引き直し後かならず手札にある', close(r.p, 1, 1e-9), 'p=' + r.p);
  const th = 1 - T.hgAtLeast(60, 4, 7, 1);
  ok(`マリガン率 理論 ${(th * 100).toFixed(2)}% / sim ${(r.mulliganRate * 100).toFixed(2)}%`, close(th, r.mulliganRate, 0.006));
}

/* ---------------------------------------------------------------- 解析 */
head('ゲーム定義');
for (const id of D.GAME_IDS) {
  const g = D.game(id);
  console.log(`  ${g.label}: デッキ${g.deckMin}${g.deckMax !== g.deckMin ? '-' + g.deckMax : ''} / 初手${g.hand} / 同名${g.maxCopies}枚まで / ` +
    `${g.aside ? g.aside.name + g.aside.count + '枚' : '伏せ札なし'} / ${g.extra ? g.extra.name : '別の山なし'}`);
}
ok('3ゲームある', D.GAME_IDS.length === 3);

head('遊戯王: エクストラデッキを別の山にする');
const y = D.parseDeck('モンスター\n3 モンスターA\n3 モンスターB\n魔法\n3 魔法C\nエクストラデッキ\n3 融合D\n2 リンクE', 'yugioh');
ok('メイン9枚', D.countIn(y, 'main') === 9);
ok('エクストラ5枚', D.countIn(y, 'extra') === 5);
ok('種別を見出しから拾う', y[0].cat === 'モンスター' && y.find(c => c.name === '魔法C').cat === '魔法');
ok('たねフラグは存在しない', D.game('yugioh').flagA === null);

head('デュエマ: 超次元を別の山にする');
const d = D.parseDeck('クリーチャー\n4 クリーチャーA\n呪文\n4 呪文B\n超次元\n4 サイキックC', 'duelmasters');
ok('メイン8枚 / 超次元4枚', D.countIn(d, 'main') === 8 && D.countIn(d, 'extra') === 4);
ok('種別を見出しから拾う', d[0].cat === 'クリーチャー' && d[1].cat === '呪文');

head('ポケカ: 従来どおり読めるか');
const p = D.parseDeck('ポケモン 7\n4 ホゲータ\nトレーナー\n4 博士の研究\n4 ネストボール\nエネルギー\n10 基本炎エネルギー', 'pokemon');
ok('4種類', p.length === 4, JSON.stringify(p.map(c => [c.name, c.cat])));
ok('博士の研究 = サポート かつ ドロー', p[1].cat === 'サポート' && p[1].draw === true);
ok('ネストボール = グッズ', p[2].cat === 'グッズ');
ok('ホゲータ = たね', p[0].basic === true);
ok('基本エネは同名制限の対象外', D.isUnlimited(p[3], 'pokemon') === true);
ok('特殊エネは対象外ではない', D.isUnlimited({ name: 'ダブルターボエネルギー', cat: 'エネルギー' }, 'pokemon') === false);

head('PTCGL 書き出し形式');
const e2 = D.parseDeck("Pokémon: 1\n4 Charizard ex OBF 125\nTrainer: 1\n4 Professor's Research SVI 189\nEnergy: 1\n10 Basic Fire Energy SVE 2\nTotal Cards: 60", 'pokemon');
ok('3種類', e2.length === 3, JSON.stringify(e2.map(c => c.name)));
ok('セット番号を除去', e2[0].name === 'Charizard ex');
ok('Total Cards 行を無視', !e2.some(c => /total/i.test(c.name)));

head('その他の入力形式');
ok('「カード名 枚数」形式', (() => { const r = D.parseDeck('ホゲータ 4\nネストボール 3枚\nミライドンex ×2', 'pokemon');
  return r.length === 3 && r[0].count === 4 && r[1].count === 3 && r[2].count === 2; })());
ok('同名カードを合算', (() => { const r = D.parseDeck('2 ネストボール\n2 ネストボール', 'pokemon'); return r.length === 1 && r[0].count === 4; })());
ok('日本語名を壊さない', D.stripSetCode('リザードンex') === 'リザードンex');

head('山札の実体化');
const inst = D.materialize(y, 'main'), ext = D.materialize(y, 'extra');
ok('メイン9枚 / エクストラ5枚に展開', inst.length === 9 && ext.length === 5);
ok('uid が全体でユニーク', new Set(inst.concat(ext).map(c => c.uid)).size === 14);
const arr = [1,2,3,4,5,6,7,8,9,10];
D.shuffle(arr);
ok('shuffle で要素が失われない', arr.slice().sort((a, b) => a - b).join() === '1,2,3,4,5,6,7,8,9,10');

head('一人回しの初手配り (dealOpening)');
{
  // ポケカ相当: 60枚・たね12枚・初手7枚。マリガン率を理論値と突き合わせる
  const build = () => {
    const a = [];
    for (let i = 0; i < 12; i++) a.push({ uid: 'b' + i, name: 'たね', basic: true });
    for (let i = 0; i < 48; i++) a.push({ uid: 'x' + i, name: '他',   basic: false });
    return D.shuffle(a);
  };
  const TRIAL = 60000;
  let mullTotal = 0, noBasic = 0, sizeBad = 0;
  for (let i = 0; i < TRIAL; i++) {
    const r = D.dealOpening(build(), 7, 'basic');
    mullTotal += r.mulligans;
    if (!r.hand.some(c => c.basic)) noBasic++;
    if (r.hand.length !== 7) sizeBad++;
  }
  // 1回のセットアップあたりの平均引き直し回数 = p/(1-p) (幾何分布)
  const p = 1 - T.hgAtLeast(60, 12, 7, 1);
  const expected = p / (1 - p);
  const actual = mullTotal / TRIAL;
  ok(`平均マリガン回数 理論 ${expected.toFixed(4)} / 実測 ${actual.toFixed(4)}`, close(expected, actual, 0.02));
  ok('引き直し後は必ず条件を満たす', noBasic === 0, noBasic + '件が未達');
  ok('手札は常に7枚', sizeBad === 0);
}
{
  const noneRule = D.dealOpening(D.shuffle(Array.from({length:40},(_,i)=>({uid:'c'+i,basic:false}))), 5, 'none');
  ok('マリガンなしのルールでは引き直さない', noneRule.mulligans === 0 && noneRule.hand.length === 5);
  // たねが1枚も無いデッキで無限ループしないこと
  const dead = D.dealOpening(D.shuffle(Array.from({length:40},(_,i)=>({uid:'d'+i,basic:false}))), 5, 'basic');
  ok('該当カードが0枚でも止まる', dead.mulligans === 0 && dead.hand.length === 5);
}

console.log(`\n=== 結果: ${pass} 件成功 / ${fail} 件失敗 ===`);
process.exit(fail ? 1 : 0);
