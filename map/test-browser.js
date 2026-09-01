/* =========================================================================
   test-browser.js — 画面の動作確認
   実行:  npm i playwright-core && node test-browser.js
   別のターミナルで  python3 -m http.server 8099  を crf/ の直下から動かしておく。
   地図タイルと現在地は本物に繋がないので、差し替えて検証する。
   ========================================================================= */
const { chromium } = require('playwright-core');
const fs = require('fs');
// 地図タイルの代わりに、その場で作った灰色の格子タイルを返す
const TILE = (() => {
  const zlib = require('zlib');
  const S = 256, px = [];
  for (let y = 0; y < S; y++) { const row = []; for (let x = 0; x < S; x++)
    row.push(y < 2 || x < 2 ? [176,186,196] : (y % 64 < 1 || x % 64 < 1) ? [206,214,222] : [228,232,236]);
    px.push(row); }
  const raw = Buffer.concat(px.map(row =>
    Buffer.concat([Buffer.from([0]), ...row.map(c => Buffer.from([c[0], c[1], c[2], 255]))])));
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  function crc32(buf) { let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = c ^ (crc >>> 8); }
    return (crc ^ 0xffffffff) >>> 0; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();

/** 位置情報つきの JPEG をその場で作る (test.js と同じ組み立て) */
function makeGpsJpeg() {
  const latDms = [[35,1],[40,1],[5232,100]], lngDms = [[139,1],[46,1],[156,100]];
  const dtBuf = Buffer.from('2026:08:27 09:30:00\0', 'ascii');
  const ifd0Off = 8, ifd0Size = 2 + 2*12 + 4;
  const dtOff = ifd0Off + ifd0Size, gpsOff = dtOff + dtBuf.length;
  const gpsSize = 2 + 4*12 + 4, latOff = gpsOff + gpsSize, lngOff = latOff + 24;
  const b = Buffer.alloc(lngOff + 24); let p = 0;
  const u16 = v => { b.writeUInt16LE(v, p); p += 2; };
  const u32 = v => { b.writeUInt32LE(v, p); p += 4; };
  const ent = (t2,ty,c,v) => { u16(t2); u16(ty); u32(c); u32(v); };
  const entRaw = (t2,ty,c,r) => { u16(t2); u16(ty); u32(c); r.copy(b,p); p += 4; };
  b.write('II', 0, 'ascii'); p = 2; u16(42); u32(ifd0Off);
  u16(2); ent(0x0132,2,dtBuf.length,dtOff); ent(0x8825,4,1,gpsOff); u32(0);
  dtBuf.copy(b,p); p += dtBuf.length;
  const ref = c => { const r = Buffer.alloc(4); r.write(c,0,'ascii'); return r; };
  u16(4); entRaw(1,2,2,ref('N')); ent(2,5,3,latOff); entRaw(3,2,2,ref('E')); ent(4,5,3,lngOff); u32(0);
  for (const [n,d] of latDms) { u32(n); u32(d); }
  for (const [n,d] of lngDms) { u32(n); u32(d); }
  const app1 = Buffer.concat([Buffer.from('Exif\0\0','ascii'), b]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xFF,0xD8]), Buffer.from([0xFF,0xE1]), len, app1, Buffer.from([0xFF,0xD9])]);
}

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (e ? '  ' + e : '')); };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    permissions: ['geolocation'],
    geolocation: { latitude: 35.6586, longitude: 139.7454 },   // 東京タワー
    locale: 'ja-JP',
  });
  const errs = [];
  let tileReqs = 0;
  await ctx.route('**/tile.openstreetmap.org/**', r => { tileReqs++; r.fulfill({ status: 200, contentType: 'image/png', body: TILE }); });

  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await pg.goto('http://localhost:8099/map/index.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(600);

  console.log('\n=== 1. 地図の表示 ===');
  ok('タイルを読み込んだ (' + tileReqs + '枚)', tileReqs > 4);
  const tilesOnScreen = await pg.$$eval('.mm-tile', ns => ns.filter(n => n.classList.contains('on')).length);
  ok('タイルが表示されている (' + tilesOnScreen + '枚)', tilesOnScreen > 4);

  // 霧が描かれているか (キャンバスに不透明なピクセルがあるか)
  const fogAlpha = () => pg.evaluate(() => {
    const c = document.querySelector('.mm-fog');
    const d = c.getContext('2d').getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
    return d[3];
  });
  ok('中心が霧で覆われている', await fogAlpha() > 100, 'alpha=' + await fogAlpha());

  console.log('\n=== 2. 地図をタップして記録 ===');
  await pg.mouse.click(195, 400);
  await pg.waitForTimeout(300);
  ok('記録シートが開く', await pg.isVisible('#edit-bg'));
  const coords = await pg.textContent('#edit-coords');
  ok('タップ地点の座標が入る', /^-?\d+\.\d+, -?\d+\.\d+$/.test(coords.trim()), coords);

  await pg.fill('#f-title', 'テスト地点A');
  await pg.fill('#f-comment', 'ここに来た');
  await pg.click('#f-save');
  await pg.waitForTimeout(500);
  ok('シートが閉じる', !(await pg.isVisible('#edit-bg')));
  ok('ピンが1本立つ', (await pg.$$('.pin')).length === 1);
  const badge1 = await pg.textContent('#b-cells');
  ok('踏破マスが増える (周囲1マス込みで9)', badge1 === '9', 'badge=' + badge1);

  console.log('\n=== 3. 霧が晴れるか ===');
  // 地図は動かしていないので、タップした (195,400) にその記録がある
  const sample = (x, y) => pg.evaluate(([x, y]) => {
    const c = document.querySelector('.mm-fog');
    const r = c.width / parseFloat(c.style.width);
    return c.getContext('2d').getImageData(Math.round(x * r), Math.round(y * r), 1, 1).data[3];
  }, [x, y]);
  ok('記録した場所の霧が消えている', await sample(195, 400) < 30, 'alpha=' + await sample(195, 400));
  ok('離れた場所は霧のまま', await sample(30, 120) > 100, 'alpha=' + await sample(30, 120));

  console.log('\n=== 3b. ピンが正しい場所に立つか ===');
  // CSS の rotate を transform と併用すると移動ベクトルごと回ってしまう。
  // 一度それで位置がずれたので、実測で押さえておく。
  const pinPos = await pg.$$eval('.pin', ns => ns.map(p => {
    const r = p.getBoundingClientRect();
    const m = parseFloat(getComputedStyle(p).marginTop);
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y - m) };
  }));
  ok('ピンの先端がタップ地点にある', pinPos.length === 1 &&
     Math.abs(pinPos[0].x - 195) <= 1 && Math.abs(pinPos[0].y - 400) <= 1,
     JSON.stringify(pinPos[0]) + ' / タップ (195,400)');

  console.log('\n=== 4. 現在地から記録 ===');
  await pg.click('#b-here');
  await pg.waitForTimeout(900);
  ok('現在地でシートが開く', await pg.isVisible('#edit-bg'));
  const c2 = await pg.textContent('#edit-coords');
  ok('現在地の座標が入る (東京タワー)', c2.startsWith('35.6586') && c2.includes('139.7454'), c2);

  console.log('\n=== 5. 写真の位置情報 ===');
  await pg.setInputFiles('#f-file', { name: 'gps.jpg', mimeType: 'image/jpeg', buffer: makeGpsJpeg() });
  await pg.waitForTimeout(900);
  const hint = await pg.textContent('#exif-hint');
  ok('写真の位置情報を検出', hint.includes('位置情報がありました'), hint.replace(/\s+/g,' ').trim());
  ok('サムネイルが出る', (await pg.$$('#f-photos .thumb')).length === 1);
  await pg.click('#exif-hint button');
  await pg.waitForTimeout(200);
  const c3 = await pg.textContent('#edit-coords');
  ok('写真の位置(東京駅)に合わせられる', c3.startsWith('35.68120') && c3.includes('139.7671'), c3);

  await pg.fill('#f-title', '東京駅');
  await pg.click('#f-save');
  await pg.waitForTimeout(600);
  ok('2件目が保存される', (await pg.$$('.pin')).length === 2);
  ok('写真ありのピンは色が違う', (await pg.$$('.pin.haspin')).length === 1);

  console.log('\n=== 6. 一覧と統計 ===');
  await pg.click('#b-list');
  await pg.waitForTimeout(500);
  const stats = await pg.$$eval('#stats .stat', ns => ns.map(n =>
    n.querySelector('.lab').textContent + '=' + n.querySelector('.val').textContent));
  console.log('  統計:', stats.join(' / '));
  ok('記録2件・写真1枚', stats.some(s => s === '記録した場所=2件') && stats.some(s => s === '写真=1枚'));
  ok('一覧に2行', (await pg.$$('.listrow')).length === 2);
  const titles = await pg.$$eval('.listrow .ltitle', ns => ns.map(n => n.textContent));
  ok('両方のタイトルが出る', titles.includes('東京駅') && titles.includes('テスト地点A'), titles.join(' / '));
  await pg.click('#list-close');

  console.log('\n=== 7. マスの細かさを変える ===');
  await pg.click('#b-menu'); await pg.waitForTimeout(300);
  const opts = await pg.$$eval('#s-grid option', ns => ns.map(n => n.textContent));
  console.log('  選択肢:', opts.join(' / '));
  // アプリの数え方を信用せず、同じ入力から独立に数えて突き合わせる
  const expectCells = (gz, halo) => pg.evaluate(async ([gz, halo]) => {
    const visits = await Store.allVisits();
    const s = new Set();
    for (const v of visits) {
      const c = Geo.cellOf(v.lat, v.lng, gz);
      if (halo) { for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) s.add((c.x+dx)+','+(c.y+dy)); }
      else s.add(c.x + ',' + c.y);
    }
    return s.size;
  }, [gz, halo]);

  for (const gz of [17, 15, 13]) {
    await pg.selectOption('#s-grid', String(gz));
    await pg.waitForTimeout(250);
    const want = await expectCells(gz, true);
    const got = +(await pg.textContent('#b-cells'));
    ok('マス数が独立計算と一致 (細かさ ' + gz + ')', got === want, got + ' / 期待 ' + want);
  }
  await pg.selectOption('#s-grid', '17');
  await pg.waitForTimeout(250);
  await pg.uncheck('#s-autofog'); await pg.waitForTimeout(300);
  ok('周囲1マスを切ると2マスになる', await pg.textContent('#b-cells') === '2',
     'badge=' + await pg.textContent('#b-cells'));
  await pg.check('#s-autofog');
  await pg.selectOption('#s-grid', '15');
  await pg.waitForTimeout(200);

  console.log('\n=== 8. 書き出し ===');
  const dl = pg.waitForEvent('download');
  await pg.click('#s-export');
  const d = await dl;
  const path = await d.path();
  const json = JSON.parse(fs.readFileSync(path, 'utf8'));
  ok('ファイル名が保たれる (ASCII)', /^trailmap-\d{4}-\d{2}-\d{2}\.json$/.test(d.suggestedFilename()),
     d.suggestedFilename());
  ok('2件ぶん入っている', json.visits.length === 2);
  ok('写真が data URL で入っている', Object.values(json.photos).length === 1 &&
     Object.values(json.photos)[0].startsWith('data:image/'));
  ok('コメントが保存されている', json.visits.some(v => v.comment === 'ここに来た'));
  await pg.click('#menu-close');

  console.log('\n=== 9. 再読み込みで残るか ===');
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);
  ok('ピンが残っている', (await pg.$$('.pin')).length === 2);
  const wantAfter = await pg.evaluate(async () => {
    const visits = await Store.allVisits();
    const gz = JSON.parse(localStorage.getItem('trailmap-prefs-v1')).grid;
    const halo = JSON.parse(localStorage.getItem('trailmap-prefs-v1')).autofog;
    const s = new Set();
    for (const v of visits) {
      const c = Geo.cellOf(v.lat, v.lng, gz);
      if (halo) { for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) s.add((c.x+dx)+','+(c.y+dy)); }
      else s.add(c.x + ',' + c.y);
    }
    return s.size;
  });
  ok('踏破マスが残っている', +(await pg.textContent('#b-cells')) === wantAfter,
     (await pg.textContent('#b-cells')) + ' / 期待 ' + wantAfter);
  ok('設定も残っている', await pg.$eval('#b-fog', n => n.getAttribute('aria-pressed')) === 'true');

  console.log('\n=== 10. 読み込み(取り込み) ===');
  await pg.click('#b-menu'); await pg.waitForTimeout(300);
  const answers = [false, true];               // 1回目=入れ替える, 2回目=はい
  const onDialog = async d => { const a = answers.shift(); a ? await d.accept() : await d.dismiss(); };
  pg.on('dialog', onDialog);
  await pg.setInputFiles('#s-import', path);
  await pg.waitForTimeout(1200);
  ok('入れ替えても2件のまま', (await pg.$$('.pin')).length === 2, (await pg.$$('.pin')).length + '本');
  pg.off('dialog', onDialog);
  const after = await pg.evaluate(async () => {
    const v = await Store.allVisits();
    return { n: v.length, titles: v.map(x => x.title).sort(), photos: v.reduce((s,x)=>s+(x.photos||[]).length,0) };
  });
  ok('取り込んだ内容が元と同じ', after.n === 2 && after.photos === 1 &&
     after.titles.join() === ['テスト地点A','東京駅'].sort().join(), JSON.stringify(after));

  await pg.screenshot({ path: 'map-main.png' });
  await pg.click('#menu-close').catch(()=>{});
  await pg.waitForTimeout(200);
  await pg.screenshot({ path: 'map-view.png' });

  console.log(errs.length ? '\n■ エラー:\n' + errs.join('\n') : '\n■ JSエラーなし');
  console.log(`\n=== 結果: ${pass} 件成功 / ${fail} 件失敗 ===`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
