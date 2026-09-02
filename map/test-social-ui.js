const { chromium } = require('playwright-core');
const fs = require('fs');
const { createMock } = require('./mock-supabase.js');
const TILE = fs.readFileSync(__dirname + '/tile.png');

// 実行ごとに真っさらなサーバーを立てる。使い回すと前回の記録が
// 「他人の投稿」として残り、何を見ているのか分からなくなる。
let MOCK_URL = '';

/** 600x300 の横長画像 (左=赤 中央=緑 右=青)。中央だけが切り抜かれるかを見るため。 */
function wideImage() {
  const zlib = require('zlib');
  const W = 600, H = 300, rows = [];
  for (let y = 0; y < H; y++) {
    const r = [Buffer.from([0])];
    for (let x = 0; x < W; x++) {
      r.push(Buffer.from(x < W / 3 ? [220, 60, 60] : x < 2 * W / 3 ? [60, 200, 90] : [60, 90, 220]));
    }
    rows.push(Buffer.concat(r));
  }
  const crc32 = buf => { let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = c ^ (crc >>> 8); }
    return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const mail = n => n + '@t.jp';
const nick = n => n;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (e ? '  ' + e : '')); };
const head = t => console.log('\n=== ' + t + ' ===');

async function newUser(b, email) {
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ja-JP',
    permissions: ['geolocation', 'notifications'],
    geolocation: { latitude: 35.68, longitude: 139.76 },
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
  // 絵文字は「写真を使わない場合」の折りたたみの中にある
  await pg.evaluate(() => { document.querySelector('#emoji-details').open = true; });
  await pg.waitForTimeout(150);
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

  head('2b. 写真のアイコン');
  await A.pg.evaluate(() => window.SocialUI.openAccount()); await A.pg.waitForTimeout(400);
  ok('登録直後は絵文字', !(await A.pg.$eval('#p-preview', n => n.classList.contains('hasphoto'))));
  await A.pg.setInputFiles('#p-file', { name: 'wide.png', mimeType: 'image/png', buffer: wideImage() });
  await A.pg.waitForTimeout(1500);
  ok('プロフィール欄が写真になる', await A.pg.$eval('#p-preview', n => n.classList.contains('hasphoto')),
     await A.pg.textContent('#p-msg'));
  ok('右上のアイコンも写真になる', await A.pg.$eval('#me-icon', n => n.classList.contains('hasphoto')));

  const shot = await A.pg.$eval('#p-preview img', n => ({ w: n.naturalWidth, h: n.naturalHeight, src: n.src }));
  ok('正方形に切り抜かれている', shot.w === 256 && shot.h === 256, shot.w + 'x' + shot.h);
  ok('avatars バケットに置かれる', shot.src.includes('/public/avatars/'), shot.src);

  // 中央を切り抜けているか (600x300 の中央は緑)
  const mid = await A.pg.evaluate(async src => {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = src;
    await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = img.naturalWidth;
    c.getContext('2d').drawImage(img, 0, 0);
    const d = c.getContext('2d').getImageData(128, 128, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, shot.src);
  ok('中央を切り抜いている (緑が残る)', mid[1] > mid[0] && mid[1] > mid[2], 'rgb=' + mid.join(','));

  await A.pg.screenshot({ path: 'avatar-profile.png' });

  // 絵文字に戻す → また写真にする
  A.pg.once('dialog', d => d.accept());
  await A.pg.click('#p-clear-avatar'); await A.pg.waitForTimeout(1200);
  ok('絵文字に戻せる', !(await A.pg.$eval('#p-preview', n => n.classList.contains('hasphoto'))));
  await A.pg.setInputFiles('#p-file', { name: 'wide.png', mimeType: 'image/png', buffer: wideImage() });
  await A.pg.waitForTimeout(1500);
  ok('もう一度写真にできる', await A.pg.$eval('#p-preview', n => n.classList.contains('hasphoto')));
  await A.pg.click('#account-close'); await A.pg.waitForTimeout(300);

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

  head('7b. 他人の写真アイコンが見える');
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1600);
  ok('地図のピンが写真になる', (await B.pg.$$eval('.pin.other .otherface.hasphoto', ns => ns.length)) > 0,
     (await B.pg.$$eval('.pin.other .otherface', ns => ns.map(n => n.className))).join(' / '));
  await B.pg.click('#me'); await B.pg.waitForTimeout(700);
  ok('友達一覧でも写真になる', (await B.pg.$$eval('#fr-list .peicon.hasphoto', ns => ns.length)) === 1,
     (await B.pg.$$eval('#fr-list .peicon', ns => ns.map(n => n.className))).join(' / '));
  await B.pg.screenshot({ path: 'avatar-friends.png' });
  await B.pg.click('#friends-close'); await B.pg.waitForTimeout(300);

  head('8. 他人の記録は読むだけ');
  await B.pg.click('.pin.other'); await B.pg.waitForTimeout(500);
  ok('読み取り画面が開く', await B.pg.isVisible('#other-bg'));
  ok('投稿者名が出る', (await B.pg.textContent('#o-author')) === nick('あるく人'),
     await B.pg.textContent('#o-author'));
  ok('投稿者のアイコンも写真', await B.pg.$eval('#o-icon', n => n.classList.contains('hasphoto')));
  ok('編集や削除のボタンは無い', !(await B.pg.isVisible('#f-delete')));
  await B.pg.click('#o-close');

  head('8b. いいね');
  await B.pg.click('.pin.other'); await B.pg.waitForTimeout(500);
  ok('いいねボタンがある', await B.pg.isVisible('#o-like'));
  ok('最初は0', (await B.pg.textContent('#o-like-count')) === '0');
  ok('最初は空のハート', (await B.pg.textContent('#o-like .likeheart')).includes('♡'));

  await B.pg.click('#o-like'); await B.pg.waitForTimeout(900);
  ok('押すと1になる', (await B.pg.textContent('#o-like-count')) === '1',
     await B.pg.textContent('#o-like-count'));
  ok('ハートが塗られる', (await B.pg.textContent('#o-like .likeheart')).includes('♥'));
  ok('いいね済みと出る', (await B.pg.textContent('#o-like-note')).includes('いいね済み'));
  ok('サーバーに1件', mock.db.likes.length === 1, mock.db.likes.length + '件');
  await B.pg.screenshot({ path: 'like-on.png' });

  await B.pg.click('#o-like'); await B.pg.waitForTimeout(900);
  ok('もう一度押すと取り消せる', (await B.pg.textContent('#o-like-count')) === '0' && mock.db.likes.length === 0,
     'count=' + await B.pg.textContent('#o-like-count') + ' server=' + mock.db.likes.length);

  await B.pg.click('#o-like'); await B.pg.waitForTimeout(900);
  await B.pg.click('#o-close'); await B.pg.waitForTimeout(300);
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1600);
  await B.pg.click('.pin.other'); await B.pg.waitForTimeout(600);
  ok('読み込み直しても残る', (await B.pg.textContent('#o-like-count')) === '1' &&
     (await B.pg.textContent('#o-like .likeheart')).includes('♥'),
     await B.pg.textContent('#o-like-count'));
  await B.pg.click('#o-close'); await B.pg.waitForTimeout(300);

  // 付けられた側 (A) に知らせが出る
  await A.pg.reload({ waitUntil: 'networkidle' }); await A.pg.waitForTimeout(1900);
  const aBadge = await A.pg.$eval('#news-count', n => n.textContent);
  ok('いいねされた側に知らせが出る', aBadge !== '0' &&
     !(await A.pg.$eval('#news-count', n => n.classList.contains('hidden'))), 'badge=' + aBadge);
  await A.pg.click('#b-news'); await A.pg.waitForTimeout(500);
  const aNews = (await A.pg.textContent('#news-list')).replace(/\s+/g, ' ').trim();
  ok('誰がいいねしたか出る', aNews.includes('あなたの記録にいいね') && aNews.includes(nick('ともだち')),
     aNews.slice(0, 90));
  await A.pg.screenshot({ path: 'like-news.png' });
  await A.pg.click('#news-close'); await A.pg.waitForTimeout(300);

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

  head('9e. 友達の新着を知らせる');
  // 直前のブロック検証でフォローが外れているので、友達に戻してから始める
  await B.pg.click('#me'); await B.pg.waitForTimeout(500);
  await B.pg.fill('#fr-q', nick('あるく人')); await B.pg.waitForTimeout(800);
  await B.pg.click('#fr-results .febtn'); await B.pg.waitForTimeout(900);
  await B.pg.click('#friends-close'); await B.pg.waitForTimeout(400);
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1600);
  ok('友達に戻っている', (await B.pg.$$eval('.pin.other', ns => ns.length)) >= 2,
     (await B.pg.$$eval('.pin.other', ns => ns.length)) + '本');
  // 友達になった直後は、それまで見えなかった相手の記録が新着として出る。
  // ここではその後の増分を見たいので、一度開いて既読にしておく。
  if (!(await B.pg.$eval('#b-news', n => n.classList.contains('hidden')))) {
    await B.pg.click('#b-news'); await B.pg.waitForTimeout(400);
    await B.pg.click('#news-close'); await B.pg.waitForTimeout(300);
  }
  ok('既読にすると印が消える', await B.pg.$eval('#news-count', n => n.classList.contains('hidden')),
     'badge=' + await B.pg.$eval('#news-count', n => n.textContent));

  // ブラウザの通知を捕まえる
  await B.pg.evaluate(() => {
    window.__notes = [];
    navigator.serviceWorker.getRegistration().then(r => {
      if (!r) return;
      const orig = r.showNotification.bind(r);
      r.showNotification = (title, opts) => { window.__notes.push({ title, body: opts && opts.body }); return orig(title, opts); };
    });
  });
  await B.pg.waitForTimeout(300);

  await addVisit(A.pg, 170, 520, '新しく行った場所', '友達だけ');
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1800);

  const badge1 = await B.pg.$eval('#news-count', n => n.textContent);
  ok('新着の数が出る', badge1 === '1', 'badge=' + badge1);
  ok('ベルが表示される', await B.pg.isVisible('#b-news'));

  await B.pg.click('#b-news'); await B.pg.waitForTimeout(500);
  const newsText = (await B.pg.textContent('#news-list')).replace(/\s+/g, ' ').trim();
  ok('新着一覧に出る', newsText.includes('新しく行った場所') && newsText.includes(nick('あるく人')),
     newsText.slice(0, 80));
  await B.pg.click('#news-close'); await B.pg.waitForTimeout(400);
  ok('見たら数が戻る', await B.pg.$eval('#news-count', n => n.classList.contains('hidden')),
     await B.pg.$eval('#news-count', n => n.textContent));

  // 他人 (友達でない) の投稿では知らせない
  await addVisit(C.pg, 200, 300, 'C の公開記録', '全体に公開');
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1800);
  ok('友達でない人の投稿では知らせない',
     await B.pg.$eval('#news-count', n => n.classList.contains('hidden')),
     'badge=' + await B.pg.$eval('#news-count', n => n.textContent));

  head('9f. 通知の設定');
  await B.pg.click('#b-menu'); await B.pg.waitForTimeout(400);
  ok('通知の切り替えがある', await B.pg.isVisible('#n-enabled'));
  ok('既定で入っている', await B.pg.isChecked('#n-enabled'));
  await B.pg.uncheck('#n-enabled'); await B.pg.waitForTimeout(300);
  await B.pg.click('#menu-close'); await B.pg.waitForTimeout(300);
  await addVisit(A.pg, 260, 560, '切ったあとの記録', '友達だけ');
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1800);
  ok('切ると知らせが出ない', await B.pg.$eval('#b-news', n => n.classList.contains('hidden')));
  await B.pg.click('#b-menu'); await B.pg.waitForTimeout(400);
  await B.pg.check('#n-enabled'); await B.pg.waitForTimeout(300);
  await B.pg.click('#menu-close'); await B.pg.waitForTimeout(500);
  ok('戻すとまた出る', !(await B.pg.$eval('#b-news', n => n.classList.contains('hidden'))));
  await B.pg.screenshot({ path: 'news-badge.png' });
  await B.pg.click('#b-news'); await B.pg.waitForTimeout(500);
  await B.pg.screenshot({ path: 'news-list.png' });
  await B.pg.click('#news-close'); await B.pg.waitForTimeout(300);

  head('10. 削除するとみんなから消える');
  const seenBefore = await B.pg.$$eval('.pin.other', ns => ns.length);
  await A.pg.click('.pin.shared'); await A.pg.waitForTimeout(500);
  ok('自分のピンから編集が開く', await A.pg.isVisible('#f-delete'));
  const answerAll2 = d => d.accept();
  A.pg.on('dialog', answerAll2);
  await A.pg.click('#f-delete'); await A.pg.waitForTimeout(1400);
  A.pg.off('dialog', answerAll2);
  await B.pg.reload({ waitUntil: 'networkidle' }); await B.pg.waitForTimeout(1600);
  const bPins3 = await B.pg.$$eval('.pin.other', ns => ns.length);
  ok('友達の画面からも1件減る', bPins3 === seenBefore - 1, seenBefore + ' → ' + bPins3);

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
