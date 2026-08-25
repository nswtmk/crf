const fs = require('fs'), vm = require('vm');
let src = fs.readFileSync(__dirname + '/app.js', 'utf8');
src += `
globalThis.__T = {
  hgPMF, hgAtLeast, logC, parseDeck, stripSetCode, simulateCombo, buildDeckArray,
  setCards: v => { cards = v; }, getCards: () => cards,
};`;
const noop = () => {};
const stubEl = { addEventListener: noop, append: noop, textContent: '', value: '', classList: { toggle: noop },
                 querySelectorAll: () => [], querySelector: () => stubEl, style: {}, dataset: {} };
const ctx = {
  document: { addEventListener: noop, querySelector: () => stubEl, querySelectorAll: () => [],
              createElement: () => Object.create(stubEl) },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  navigator: {}, window: { addEventListener: noop }, alert: noop, console,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const T = ctx.__T;

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { cond ? pass++ : fail++; console.log((cond?'  ok  ':'  FAIL') + '  ' + name + (extra?'  '+extra:'')); };
const close = (a, b, tol) => Math.abs(a - b) < tol;

console.log('\n=== 1. 超幾何分布: 手計算との突き合わせ ===');
// P(4枚積みが初手7枚に1枚以上) = 1 - (53*52*51*50)/(60*59*58*57)
const exact4 = 1 - (53*52*51*50)/(60*59*58*57);
ok('4枚積みが初手7枚に来る = ' + (exact4*100).toFixed(4) + '%',
   close(T.hgAtLeast(60,4,7,1), exact4, 1e-12), 'app=' + T.hgAtLeast(60,4,7,1).toFixed(10));
// P(1枚積みが初手7枚) = 7/60
ok('1枚積みが初手7枚 = 7/60', close(T.hgAtLeast(60,1,7,1), 7/60, 1e-12));
// P(1枚積みがサイド6枚に落ちる) = 6/60 = 10%
ok('1枚積みのサイド落ち = 10%', close(T.hgAtLeast(60,1,6,1), 0.1, 1e-12));
// 確率の総和 = 1
let s = 0; for (let x = 0; x <= 4; x++) s += T.hgPMF(60,4,7,x);
ok('PMFの総和 = 1', close(s, 1, 1e-12), 's=' + s);
// 60枚すべて見れば必ず引ける
ok('54枚見て4枚積み(サイド6を除く全部)', close(T.hgAtLeast(60,4,54,1), 1 - (6*5*4*3)/(60*59*58*57), 1e-12));
// 大きな二項係数でも精度が落ちないこと (60C30 は 2^53 超)
ok('logC(60,30) が正しい', close(T.logC(60,30), Math.log(118264581564861424), 1e-9),
   'exp=' + Math.exp(T.logC(60,30)).toExponential(6));

console.log('\n=== 2. 超幾何分布 vs 総当たりシミュレーション ===');
function bruteforce(K, n, trials) {
  let hit = 0;
  for (let t = 0; t < trials; t++) {
    const d = new Array(60).fill(0); for (let i = 0; i < K; i++) d[i] = 1;
    for (let i = 59; i > 0; i--) { const j = (Math.random()*(i+1))|0; const tmp=d[i]; d[i]=d[j]; d[j]=tmp; }
    let c = 0; for (let i = 0; i < n; i++) c += d[i];
    if (c >= 1) hit++;
  }
  return hit / trials;
}
for (const [K, n] of [[4,7],[2,7],[1,13],[3,20],[10,7]]) {
  const e = T.hgAtLeast(60,K,n,1), m = bruteforce(K,n,200000);
  ok(`K=${K} n=${n}: 理論 ${(e*100).toFixed(2)}% / 実測 ${(m*100).toFixed(2)}%`, close(e,m,0.005));
}

console.log('\n=== 3. マリガン率 ===');
for (const B of [8,10,12,15]) {
  const p = 1 - T.hgAtLeast(60,B,7,1);
  console.log(`  たね${B}枚 → マリガン率 ${(p*100).toFixed(2)}%`);
}
ok('たねが多いほどマリガン率は下がる',
   (1-T.hgAtLeast(60,8,7,1)) > (1-T.hgAtLeast(60,12,7,1)));
ok('たね0枚 → マリガン率100%', close(1-T.hgAtLeast(60,0,7,1), 1, 1e-12));

console.log('\n=== 4. シミュレーションが理論値と一致するか ===');
// たねを大量に入れてマリガンをほぼ起こさせず、単独カードの確率を理論値と比べる
const deck = [
  { name:'A', count:4, cat:'ポケモン', basic:true,  draw:false },
  { name:'B', count:2, cat:'グッズ',   basic:false, draw:false },
  { name:'たね埋め', count:20, cat:'ポケモン', basic:true, draw:false },
  { name:'埋め', count:34, cat:'グッズ', basic:false, draw:false },
];
T.setCards(deck);
ok('デッキ配列が60枚', T.buildDeckArray(new Set([0])).length === 60);
for (const seen of [7, 13, 20]) {
  const r = T.simulateCombo([{card: deck[1], need: 1}], seen, 200000);
  const e = T.hgAtLeast(60, 2, seen, 1);
  ok(`単独カード seen=${seen}: 理論 ${(e*100).toFixed(2)}% / sim ${(r.p*100).toFixed(2)}%`, close(e, r.p, 0.006));
}
// 2枚コンボ: 多変量超幾何を直接計算して比較
function comboExact(K1, need1, K2, need2, n) {
  let s = 0;
  for (let a = need1; a <= Math.min(K1, n); a++)
    for (let b = need2; b <= Math.min(K2, n - a); b++)
      s += Math.exp(T.logC(K1,a) + T.logC(K2,b) + T.logC(60-K1-K2, n-a-b) - T.logC(60,n));
  return s;
}
{
  const r = T.simulateCombo([{card:deck[0],need:1},{card:deck[1],need:1}], 13, 300000);
  const e = comboExact(4,1,2,1,13);
  ok(`2枚コンボ seen=13: 理論 ${(e*100).toFixed(2)}% / sim ${(r.p*100).toFixed(2)}%`, close(e,r.p,0.007));
}
{
  const r = T.simulateCombo([{card:deck[0],need:2}], 20, 300000);
  const e = T.hgAtLeast(60,4,20,2);
  ok(`同名2枚要求 seen=20: 理論 ${(e*100).toFixed(2)}% / sim ${(r.p*100).toFixed(2)}%`, close(e,r.p,0.007));
}

console.log('\n=== 5. マリガンの引き直しが効いているか ===');
{
  // たね4枚だけのデッキ。マリガン後は必ずたねが手札にある = A>=1 が 100% のはず
  const d2 = [
    { name:'A', count:4, cat:'ポケモン', basic:true, draw:false },
    { name:'埋め', count:56, cat:'グッズ', basic:false, draw:false },
  ];
  T.setCards(d2);
  const r = T.simulateCombo([{card:d2[0], need:1}], 7, 100000);
  ok('唯一のたねは引き直し後かならず手札にある', close(r.p, 1, 1e-9), 'p=' + r.p);
  const theoryMull = 1 - T.hgAtLeast(60,4,7,1);
  ok(`マリガン率 理論 ${(theoryMull*100).toFixed(2)}% / sim ${(r.mulliganRate*100).toFixed(2)}%`,
     close(theoryMull, r.mulliganRate, 0.006));
}

console.log('\n=== 6. デッキリストの解析 ===');
{
  const jp = T.parseDeck(`ポケモン 7
4 ホゲータ
3 アチゲータ

トレーナー 4
4 博士の研究

エネルギー 49
49 基本炎エネルギー`);
  ok('日本語リストを7種類…ではなく4種類として読む', jp.length === 4, JSON.stringify(jp.map(c=>c.name)));
  ok('合計60枚', jp.reduce((s,c)=>s+c.count,0) === 60);
  ok('ポケモンに分類', jp[0].cat === 'ポケモン' && jp[0].basic === true);
  ok('博士の研究をサポート+ドロサポと判定', jp[2].cat === 'サポート' && jp[2].draw === true);
  ok('エネルギーに分類', jp[3].cat === 'エネルギー');
}
{
  const en = T.parseDeck(`Pokémon: 2
4 Charizard ex OBF 125
2 Pidgeot ex OBF 164

Trainer: 1
4 Professor's Research SVI 189

Energy: 1
10 Basic Fire Energy SVE 2

Total Cards: 60`);
  ok('PTCGL形式を4種類として読む', en.length === 4, JSON.stringify(en.map(c=>c.name)));
  ok('セット番号を除去', en[0].name === 'Charizard ex', '→ "' + en[0].name + '"');
  ok('Total Cards 行を無視', !en.some(c => /total/i.test(c.name)));
  ok("Professor's Research をドロサポ判定", en[2].draw === true);
}
{
  const rev = T.parseDeck('ホゲータ 4\nネストボール 3枚\nミライドンex ×2');
  ok('「カード名 枚数」形式も読む', rev.length === 3 && rev[0].count === 4 && rev[1].count === 3 && rev[2].count === 2,
     JSON.stringify(rev.map(c=>[c.name,c.count])));
}
{
  const dup = T.parseDeck('2 ネストボール\n2 ネストボール');
  ok('同名カードを合算', dup.length === 1 && dup[0].count === 4);
}
ok('セット記号の除去', T.stripSetCode('Iono PAL 185') === 'Iono', '→ ' + T.stripSetCode('Iono PAL 185'));
ok('日本語名は壊さない', T.stripSetCode('リザードンex') === 'リザードンex');

console.log(`\n=== 結果: ${pass} 件成功 / ${fail} 件失敗 ===`);
process.exit(fail ? 1 : 0);
