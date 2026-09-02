const { chromium } = require('playwright-core');
const fs = require('fs');
const { createMock } = require('./mock-supabase.js');
const TILE = fs.readFileSync(__dirname + '/tile.png');

// 実行ごとに真っさらなサーバーを立てる。使い回すと前回の記録が
// 「他人の投稿」として残り、何を見ているのか分からなくなる。
let MOCK_URL = '';
const mail = n => n + '@t.jp';
const nick = n => n;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (e ? '  ' + e : '')); };
const head = t => console.log('\n=== ' + t + ' ===');

async function newUser(b, email) {
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ja-JP',
    permissions: ['geolocation'], geolocation: { latitude: 35.68, longitude: 139.76 },
  });
  await ctx.route('**/tile.openstreetmap.org/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(email + ' PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(email + ' CONSOLE: ' + m.text()); });
  await pg.goto('http://localhost:8099/map/index.html', { waitUntil: 'networkidle' });
  await pg.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('trailmap'); });
  await pg.evaluate(u => localStorage.setItem('trailmap-supabase-v1',
    JSON.stringify({ url: u, anonKey: 'anon-test-key-1234567890' })), MOCK_URL);
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(500);
  return { pg, errs, ctx };
}

async function signUp(pg, email, nick, emoji) {
  await pg.click('#me'); await pg.waitForTimeout(300);
  await pg.fill('#a-email', email);
  await pg.fill('#a-pass', 'password1');
  await pg.click('#a-signup');
  await pg.waitForTimeout(900);
  await pg.fill('#p-nick', nick);
  await pg.click(`.emojibtn:has-text("${emoji}")`);
  await pg.click('#p-save');
  await pg.waitForTimeout(700);
}

async function addVisit(pg, x, y, title, vis) {
  await pg.mouse.click(x, y); await pg.waitForTimeout(350);
  await pg.fill('#f-title', title);
  await pg.click(`.visbtn:has-text("${vis}")`);
  await pg.waitForTimeout(150);
  await pg.click('#f-save');
  await pg.waitForTimeout(900);
}

(async () => {
  const mock = createMock();
  await new Promise(r => mock.server.listen(0, r));
  MOCK_URL = 'http://localhost:' + mock.server.address().port;
  console.log('検証用サーバー:', MOCK_URL);

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const A = await newUser(b, mail('a'));
  const B = await newUser(b, mail('b'));
  const C = await newUser(b, mail('c'));

  head('1. 未設定・未ログインでも地図は動く');
  ok('ピンを立てられる', true);
  await addVisit(A.pg, 195, 400, 'ログイン前の記録', '自分だけ');
  ok('未ログインでも記録できる', (await A.pg.$$('.pin')).length === 1);
  ok('アイコンは「ログイン」表示', (await A.pg.textContent('#me-name')) === 'ログイン');

  head('2. 登録とプロフィール');
  await signUp(A.pg, mail('a'), nick('あるく人'), '🚶');
  await signUp(B.pg, mail('b'), nick('ともだち'), '🐱');
  await signUp(C.pg, mail('c'), nick('たにん'), '🦊');
  ok('ニックネームが右上に出る', (await A.pg.textContent('#me-name')) === nick('あるく人'),
     await A.pg.textContent('#me-name'));
  ok('アイコンが反映される', (await A.pg.textContent('#me-icon')) === '🚶');
  await A.pg.click('#account-close');
  await B.pg.click('#account-close');
  await C.pg.click('#account-close');

  head('3. 公開範囲の既定と注意書き');
  await A.pg.mouse.click(160, 350); await A.pg.waitForTimeout(350);
  const onBtn = await A.pg.$eval('.visbtn.on', n => n.textContent);
  ok('既定は「自分だけ」', onBtn.includes('自分だけ'), onBtn);
  ok('端末内にとどまると書いてある', (await A.pg.textContent('#vis-hint')).includes('端末の中だけ'));
  await A.pg.click('.visbtn:has-text("全体に公開")'); await A.pg.waitForTimeout(200);
  ok('全体公開には注意書きが出る', (await A.pg.textContent('#vis-hint')).includes('自宅や職場'),
     await A.pg.textContent('#vis-hint'));
  await A.pg.click('#f-cancel');

  head('4. 記録を作って共有する');
  await addVisit(A.pg, 150, 300, '友達に見せる場所', '友達だけ');
  await addVisit(A.pg, 240, 480, 'みんなに見せる場所', '全体に公開');
  ok('記録が3件', (await A.pg.$$('.pin')).length === 3);
  ok('共有中のピンに印が付く', (await A.pg.$$('.pin.shared')).length === 2,
     (await A.pg.$$('.pin.shared')).length + '本');

  head('5. 片方向フォローでは見えない');
  await B.pg.click('#me'); await B.pg.waitForTimeout(400);
  await B.pg.fill('#fr-q', nick('あるく人')); await B.pg.waitForTimeout(700);
  ok('相手が検索で見つかる', (await B.pg.$$('#fr-results .person')).length === 1,
     await B.pg.textContent('#fr-results'));
  await B.pg.click('#fr-results .febtn'); await B.pg.waitForTimeout(800);
  ok('フォロー中になる', (await B.pg.textContent('#fr-results .febtn')) === 'フォロー中');
  await B.pg.click('#friends-close'); await B.pg.waitForTimeout(900);
  const bPins1 = await B.pg.$$eval('.pin.other', ns => ns.length);
  ok('片方向では友達限定が見えない (公開のみ1件)', bPins1 === 1, bPins1 + '本');

  head('6. 相互フォローで友達になる');
  await A.pg.click('#me'); await A.pg.waitForTimeout(500);
  await A.pg.fill('#fr-q', nick('ともだち')); await A.pg.waitForTimeout(700);
  await A.pg.click('#fr-results .febtn'); await A.pg.waitForTimeout(800);
  await A.pg.click('#friends-close');
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1500);
  const bPins2 = await B.pg.$$eval('.pin.other', ns => ns.length);
  ok('友達になると2件見える', bPins2 === 2, bPins2 + '本');

  await B.pg.click('#me'); await B.pg.waitForTimeout(600);
  const rel = await B.pg.textContent('#fr-list');
  ok('友達タブに相手が出る', rel.includes(nick('あるく人')) && rel.includes('おたがいにフォロー'),
     rel.replace(/\s+/g, ' ').trim().slice(0, 80));
  await B.pg.click('#friends-close');

  head('7. 他人には友達限定が見えない');
  await C.pg.reload({ waitUntil: 'networkidle' }); await C.pg.waitForTimeout(1500);
  const cPins = await C.pg.$$eval('.pin.other', ns => ns.length);
  ok('公開の1件だけ見える', cPins === 1, cPins + '本');

  head('8. 他人の記録は読むだけ');
  await B.pg.click('.pin.other'); await B.pg.waitForTimeout(500);
  ok('読み取り画面が開く', await B.pg.isVisible('#other-bg'));
  ok('投稿者名が出る', (await B.pg.textContent('#o-author')) === nick('あるく人'),
     await B.pg.textContent('#o-author'));
  ok('編集や削除のボタンは無い', !(await B.pg.isVisible('#f-delete')));
  await B.pg.click('#o-close');

  head('9. 霧は自分の足あとだけで晴れる');
  const bCells = await B.pg.textContent('#b-cells');
  ok('他人の記録では霧が晴れない', bCells === '0', 'マス数=' + bCells);

  head('9b. 地図のドラッグは壊れていない');
  const c0 = await B.pg.evaluate(() => document.querySelector('#b-cells').textContent);
  const before9 = await B.pg.evaluate(() => JSON.parse(localStorage.getItem('trailmap-prefs-v1')));
  await B.pg.mouse.move(200, 500); await B.pg.mouse.down();
  await B.pg.mouse.move(200, 380, { steps: 8 }); await B.pg.mouse.up();
  await B.pg.waitForTimeout(400);
  const after9 = await B.pg.evaluate(() => JSON.parse(localStorage.getItem('trailmap-prefs-v1')));
  ok('ドラッグで地図が動く', Math.abs(after9.lat - before9.lat) > 1e-5,
     before9.lat.toFixed(5) + ' → ' + after9.lat.toFixed(5));
  ok('ドラッグでは記録が作られない', !(await B.pg.isVisible('#edit-bg')));

  head('9c. 通報とブロック (App Store の要件)');
  await B.pg.click('.pin.other'); await B.pg.waitForTimeout(500);
  ok('通報ボタンがある', await B.pg.isVisible('#o-report'));
  ok('ブロックボタンがある', await B.pg.isVisible('#o-block'));
  await B.pg.click('#o-report'); await B.pg.waitForTimeout(400);
  ok('通報の理由が選べる', (await B.pg.$$('#rp-reasons .reasonbtn')).length === 4,
     (await B.pg.$$('#rp-reasons .reasonbtn')).length + '個');
  await B.pg.fill('#rp-note', 'テストの通報');
  B.pg.once('dialog', d => d.accept());
  await B.pg.click('#rp-send'); await B.pg.waitForTimeout(900);
  ok('通報がサーバーに届く', mock.db.reports.length === 1, mock.db.reports.length + '件');
  ok('通報後は画面が閉じる', !(await B.pg.isVisible('#report-bg')));

  const beforeBlock = await B.pg.$$eval('.pin.other', ns => ns.length);
  await B.pg.click('.pin.other'); await B.pg.waitForTimeout(400);
  // once を並べると1つ目のダイアログに両方が反応してしまう。順に応答させる。
  const answerAll = d => d.accept();
  B.pg.on('dialog', answerAll);
  await B.pg.click('#o-block'); await B.pg.waitForTimeout(1800);
  B.pg.off('dialog', answerAll);
  const afterBlock = await B.pg.$$eval('.pin.other', ns => ns.length);
  ok('ブロックすると相手のピンが消える', afterBlock < beforeBlock, beforeBlock + ' → ' + afterBlock);

  await B.pg.click('#me'); await B.pg.waitForTimeout(600);
  await B.pg.click('.tabrow .tab[data-tab="blocked"]'); await B.pg.waitForTimeout(600);
  ok('ブロック一覧に出る', (await B.pg.textContent('#fr-list')).includes('ブロック中'),
     (await B.pg.textContent('#fr-list')).replace(/\s+/g,' ').trim().slice(0, 60));
  await B.pg.click('#fr-list .febtn'); await B.pg.waitForTimeout(1000);
  await B.pg.click('#friends-close'); await B.pg.waitForTimeout(1200);
  // ブロックするとフォローも外れる。解除しても友達には戻らないので、
  // 見えるのは全体公開の分だけ。勝手に友達関係が復活しないことの確認でもある。
  const afterUnblock = await B.pg.$$eval('.pin.other', ns => ns.length);
  ok('解除すると全体公開の分だけ戻る', afterUnblock === 1, afterUnblock + '本 (ブロック前は' + beforeBlock + '本)');
  await B.pg.click('#me'); await B.pg.waitForTimeout(600);
  const rel2 = await B.pg.textContent('#fr-list');
  ok('友達関係は復活しない', !rel2.includes('おたがいにフォロー'),
     rel2.replace(/\s+/g, ' ').trim().slice(0, 60));
  await B.pg.click('#friends-close'); await B.pg.waitForTimeout(300);

  head('9d. 連絡先が出ている (ガイドライン 1.2)');
  await B.pg.click('#b-menu'); await B.pg.waitForTimeout(400);
  const contact = await B.pg.getAttribute('#contact-mail', 'href');
  ok('問い合わせ先が載っている', contact && contact.startsWith('mailto:'), contact);
  await B.pg.click('#menu-close');

  head('10. 削除するとみんなから消える');
  await A.pg.click('.pin.shared'); await A.pg.waitForTimeout(500);
  ok('自分のピンから編集が開く', await A.pg.isVisible('#f-delete'));
  A.pg.once('dialog', d => d.accept());
  await A.pg.click('#f-delete'); await A.pg.waitForTimeout(1200);
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1500);
  const bPins3 = await B.pg.$$eval('.pin.other', ns => ns.length);
  ok('友達の画面からも消える', bPins3 === 1, bPins3 + '本');

  head('11. ログアウトしても端末の記録は残る');
  const before = (await A.pg.$$('.pin')).length;
  await A.pg.click('#me'); await A.pg.waitForTimeout(400);
  await A.pg.click('#friends-close').catch(() => {});
  await A.pg.evaluate(() => window.SocialUI.openAccount()); await A.pg.waitForTimeout(400);
  A.pg.once('dialog', d => d.accept());
  await A.pg.click('#a-signout'); await A.pg.waitForTimeout(900);
  ok('記録は消えない', (await A.pg.$$('.pin')).length === before, before + ' → ' + (await A.pg.$$('.pin')).length);
  ok('他人のピンは消える', (await A.pg.$$('.pin.other')).length === 0);
  ok('右上が「ログイン」に戻る', (await A.pg.textContent('#me-name')) === 'ログイン');

  await A.pg.screenshot({ path: 'social-a.png' });
  await B.pg.screenshot({ path: 'social-b.png' });
  await B.pg.click('#me'); await B.pg.waitForTimeout(600);
  await B.pg.screenshot({ path: 'social-friends.png' });

  const errs = [...A.errs, ...B.errs, ...C.errs];
  console.log(errs.length ? '\n■ エラー:\n' + errs.join('\n') : '\n■ JSエラーなし');
  console.log(`\n=== 結果: ${pass} 件成功 / ${fail} 件失敗 ===`);
  await b.close();
  mock.server.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
