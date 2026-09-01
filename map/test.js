/* =========================================================================
   test.js — 座標計算と EXIF 読み取りの検証 (ブラウザ不要)
   実行:  node test.js
   画面まわりの検証は test-browser.js (playwright-core が必要)
   ========================================================================= */
require('./geo.js');
require('./exif.js');
const G = globalThis.Geo, E = globalThis.Exif;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (e ? '  ' + e : '')); };
const near = (a, b, tol) => Math.abs(a - b) < tol;
const head = t => console.log('\n=== ' + t + ' ===');

/* ------------------------------------------------------- メルカトル変換 */
head('Web メルカトルの座標変換');
ok('ズーム0の世界は256px', G.worldSize(0) === 256);
ok('経度0は中央', near(G.lngToX(0, 0), 128, 1e-9));
ok('緯度0は中央', near(G.latToY(0, 0), 128, 1e-9));
ok('経度-180は左端', near(G.lngToX(-180, 0), 0, 1e-9));
ok('経度180は右端', near(G.lngToX(180, 0), 256, 1e-9));
ok('北の限界は上端', near(G.latToY(G.MAX_LAT, 0), 0, 1e-6));
ok('南の限界は下端', near(G.latToY(-G.MAX_LAT, 0), 256, 1e-6));

// 往復して元に戻ること (投影の実装ミスはここで出る)
for (const [lat, lng] of [[35.6812, 139.7671], [-33.8688, 151.2093], [64.1466, -21.9426], [0, 0], [51.5, -0.12]]) {
  for (const z of [2, 10, 18]) {
    const x = G.lngToX(lng, z), y = G.latToY(lat, z);
    const back = { lat: G.yToLat(y, z), lng: G.xToLng(x, z) };
    if (!near(back.lat, lat, 1e-9) || !near(back.lng, lng, 1e-9)) {
      ok(`往復 z=${z} (${lat},${lng})`, false, JSON.stringify(back));
    }
  }
}
ok('緯度経度→ピクセル→緯度経度が一致する (5地点×3ズーム)', true);

ok('限界を超える緯度は丸める', near(G.latToY(89, 0), G.latToY(G.MAX_LAT, 0), 1e-9));

/* --------------------------------------------------------------- 距離 */
head('距離の計算');
const cases = [
  ['東京駅→新宿駅', 35.6812, 139.7671, 35.6896, 139.7006, 6100, 300],
  ['東京駅→大阪駅', 35.6812, 139.7671, 34.7025, 135.4959, 403000, 4000],
  ['同じ点',        35.0,    139.0,    35.0,    139.0,    0,      0.001],
];
for (const [name, a, b, c, d, want, tol] of cases) {
  const got = G.distance(a, b, c, d);
  ok(name + ' = ' + Math.round(got) + 'm', near(got, want, tol), '想定 約' + want + 'm');
}

/* ----------------------------------------------------------- グリッド */
head('未踏エリアのマス');
for (const lv of G.GRID_LEVELS) {
  console.log('  ' + lv.label.padEnd(6), 'z=' + lv.zoom, '→ 東京で約' + Math.round(G.cellMeters(35.68, lv.zoom)) + 'm四方');
}
ok('細かくするほどマスは小さい',
   G.cellMeters(35.68, 17) < G.cellMeters(35.68, 15) && G.cellMeters(35.68, 15) < G.cellMeters(35.68, 13));
ok('高緯度ほどマスは小さい (メルカトル)', G.cellMeters(60, 15) < G.cellMeters(0, 15));

// 同じマスに入るか / 別のマスになるか
const z15 = 15;
ok('数十m違いは同じマスになりうる',
   G.cellKey(35.6812, 139.7671, z15) === G.cellKey(35.68125, 139.76715, z15));
ok('1km離れれば別のマス',
   G.cellKey(35.6812, 139.7671, z15) !== G.cellKey(35.6912, 139.7671, z15));
{
  // マスの中心を取り直しても同じマスに戻ること
  const c = G.cellOf(35.6812, 139.7671, z15);
  const lat = G.yToLat((c.y + 0.5) * G.TILE, z15);
  const lng = G.xToLng((c.x + 0.5) * G.TILE, z15);
  const c2 = G.cellOf(lat, lng, z15);
  ok('マスの中心から引き直しても同じマス', c.x === c2.x && c.y === c2.y);
}

/* -------------------------------------------------------------- EXIF */
head('写真の位置情報 (EXIF)');

/** GPS 付きの最小 JPEG を組み立てる */
function makeJpeg(latDms, latRef, lngDms, lngRef, dt, little) {
  const dtBuf = Buffer.from(dt + '\0', 'ascii');
  const ifd0Off = 8, ifd0Size = 2 + 2 * 12 + 4;
  const dtOff = ifd0Off + ifd0Size;
  const gpsOff = dtOff + dtBuf.length;
  const gpsSize = 2 + 4 * 12 + 4;
  const latOff = gpsOff + gpsSize, lngOff = latOff + 24;

  const b = Buffer.alloc(lngOff + 24);
  let p = 0;
  const u16 = v => { little ? b.writeUInt16LE(v, p) : b.writeUInt16BE(v, p); p += 2; };
  const u32 = v => { little ? b.writeUInt32LE(v, p) : b.writeUInt32BE(v, p); p += 4; };
  const entry = (tag, type, count, val) => { u16(tag); u16(type); u32(count); u32(val); };
  const entryRaw = (tag, type, count, raw) => { u16(tag); u16(type); u32(count); raw.copy(b, p); p += 4; };

  b.write(little ? 'II' : 'MM', 0, 'ascii'); p = 2;
  u16(42); u32(ifd0Off);
  u16(2);
  entry(0x0132, 2, dtBuf.length, dtOff);      // DateTime
  entry(0x8825, 4, 1, gpsOff);                // GPS IFD
  u32(0);
  dtBuf.copy(b, p); p += dtBuf.length;

  const ref = c => { const r = Buffer.alloc(4); r.write(c, 0, 'ascii'); return r; };
  u16(4);
  entryRaw(1, 2, 2, ref(latRef));
  entry(2, 5, 3, latOff);
  entryRaw(3, 2, 2, ref(lngRef));
  entry(4, 5, 3, lngOff);
  u32(0);
  for (const [n, d] of latDms) { u32(n); u32(d); }
  for (const [n, d] of lngDms) { u32(n); u32(d); }

  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), b]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from([0xFF, 0xE1]), len, app1, Buffer.from([0xFF, 0xD9])]);
}
const toAB = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const TOKYO_LAT = [[35, 1], [40, 1], [5232, 100]];      // 35.6812
const TOKYO_LNG = [[139, 1], [46, 1], [156, 100]];      // 139.7671

{
  const r = E.parse(toAB(makeJpeg(TOKYO_LAT, 'N', TOKYO_LNG, 'E', '2026:08:27 09:30:00', true)));
  ok('リトルエンディアン: 東京駅を読める', near(r.lat, 35.6812, 1e-4) && near(r.lng, 139.7671, 1e-4),
     r.lat + ', ' + r.lng);
  ok('撮影日時を読める', new Date(r.takenAt).getFullYear() === 2026 && new Date(r.takenAt).getHours() === 9);
}
{
  const r = E.parse(toAB(makeJpeg(TOKYO_LAT, 'N', TOKYO_LNG, 'E', '2026:08:27 09:30:00', false)));
  ok('ビッグエンディアンでも同じ結果', near(r.lat, 35.6812, 1e-4) && near(r.lng, 139.7671, 1e-4));
}
{
  // 南半球・西経は負の値になる
  const r = E.parse(toAB(makeJpeg([[33, 1], [52, 1], [736, 100]], 'S',
                                  [[151, 1], [12, 1], [3348, 100]], 'W', '2020:01:02 03:04:05', true)));
  ok('南緯は負になる', r.lat < 0 && near(r.lat, -33.8687, 1e-3), String(r.lat));
  ok('西経は負になる', r.lng < 0 && near(r.lng, -151.2093, 1e-3), String(r.lng));
}
{
  // 0,0 は「位置情報なし」の機種があるので採用しない
  const r = E.parse(toAB(makeJpeg([[0, 1], [0, 1], [0, 1]], 'N', [[0, 1], [0, 1], [0, 1]], 'E', '2020:01:02 03:04:05', true)));
  ok('緯度経度が0,0なら採用しない', r.lat === null && r.lng === null);
}
ok('EXIF の無い JPEG', (r => r.lat === null && r.takenAt === null)(
   E.parse(toAB(Buffer.from([0xFF, 0xD8, 0xFF, 0xDB, 0, 4, 0, 0, 0xFF, 0xD9])))));
ok('壊れたデータでも例外を投げない', (r => r.lat === null)(
   E.parse(toAB(Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0, 5, 1])))));
ok('空のデータ', (r => r.lat === null)(E.parse(new ArrayBuffer(0))));
ok('JPEG ですらないデータ', (r => r.lat === null)(E.parse(toAB(Buffer.from('hello world')))));

head('度分秒の変換');
ok('35°40\'52.32" N = 35.6812', near(G.dmsToDeg(35, 40, 52.32, 'N'), 35.6812, 1e-6));
ok('S は負になる', near(G.dmsToDeg(33, 52, 7.36, 'S'), -33.868711, 1e-6));
ok('W は負になる', near(G.dmsToDeg(151, 12, 33.48, 'W'), -151.2093, 1e-6));

console.log(`\n=== 結果: ${pass} 件成功 / ${fail} 件失敗 ===`);
process.exit(fail ? 1 : 0);
