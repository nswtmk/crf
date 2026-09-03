const { chromium } = require('playwright-core');
const fs = require('fs');
const { createMock } = require('./mock-supabase.js');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (e ? '  ' + e : '')); };

(async () => {
  const mock = createMock();
  await new Promise(r => mock.server.listen(0, r));
  const URL_ = 'http://localhost:' + mock.server.address().port;

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ja-JP' });
  const errs = [];
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  // config.js に値が入っている状態を再現する
  await ctx.route('**/map/config.js', r => r.fulfill({
    status: 200, contentType: 'text/javascript',
    body: `window.TRAILMAP_SUPABASE={url:'${URL_}',anonKey:'sb_publishable_builtin123456'};
           window.TRAILMAP_CONTACT='test@example.com';`,
  }));

  await pg.goto('http://localhost:8099/map/index.html', { waitUntil: 'networkidle' });
  await pg.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('trailmap'); });
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(600);

  console.log('\n=== 埋め込み済みのとき ===');
  await pg.click('#me'); await pg.waitForTimeout(400);
  ok('URL とキーの入力欄が出ない', !(await pg.isVisible('#a-url')));
  ok('いきなりログイン欄が出る', await pg.isVisible('#a-email'));
  ok('「接続先の設定を消す」も出ない', !(await pg.isVisible('#a-forget')));

  await pg.fill('#a-email', 'builtin@t.jp');
  await pg.fill('#a-pass', 'password1');
  await pg.click('#a-signup'); await pg.waitForTimeout(1200);
  ok('そのまま登録できる', mock.db.users.length === 1, mock.db.users.length + '人');
  ok('プロフィール欄が出る', await pg.isVisible('#p-nick'));
  await pg.fill('#p-nick', 'うめこみ');
  await pg.click('#p-save'); await pg.waitForTimeout(800);
  ok('右上が名前に変わる', (await pg.textContent('#me-name')) === 'うめこみ',
     await pg.textContent('#me-name'));
  ok('連絡先も config から反映される',
     (await pg.getAttribute('#contact-mail', 'href')).includes('test@example.com'));
  await pg.screenshot({ path: 'builtin-login.png' });

  console.log('\n=== 埋め込みが空のとき (今の状態) ===');
  const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  const pg2 = await ctx2.newPage();
  pg2.on('pageerror', e => errs.push('PAGEERROR2: ' + e.message));
  await pg2.goto('http://localhost:8099/map/index.html', { waitUntil: 'networkidle' });
  await pg2.evaluate(() => localStorage.clear());
  await pg2.reload({ waitUntil: 'networkidle' });
  await pg2.waitForTimeout(600);
  await pg2.click('#me'); await pg2.waitForTimeout(400);
  ok('これまでどおり手で設定できる', await pg2.isVisible('#a-url'));
  ok('記録は変わらず取れる', await pg2.isVisible('#b-here'));

  console.log(errs.length ? '\n■ エラー:\n' + errs.join('\n') : '\n■ JSエラーなし');
  console.log(`\n=== 結果: ${pass} 件成功 / ${fail} 件失敗 ===`);
  await b.close(); mock.server.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
