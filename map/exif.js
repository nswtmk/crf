'use strict';

/* =========================================================================
   exif.js — JPEG の EXIF から撮影位置と撮影日時を取り出す
   写真を選んだときに「この場所で記録しますか」と聞くために使う。
   読み取りだけで、写真を書き換えることはしない。
   ========================================================================= */

(function (global) {

  // TIFF のデータ型ごとのバイト数
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  const TAG_GPS_IFD   = 0x8825;
  const TAG_EXIF_IFD  = 0x8769;
  const TAG_DATETIME  = 0x0132;   // IFD0
  const TAG_DATETIME_ORIGINAL = 0x9003;   // Exif IFD

  /**
   * JPEG の ArrayBuffer から位置と日時を取り出す。
   * 見つからなければ該当キーを null にして返す。EXIF が壊れていても例外は投げない。
   */
  function parse(buffer) {
    const out = { lat: null, lng: null, altitude: null, takenAt: null };
    try {
      const view = new DataView(buffer);
      if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return out;   // SOI が無い

      // APP1 (FFE1) セグメントを探す
      let off = 2;
      let tiffStart = -1;
      while (off + 4 <= view.byteLength) {
        const marker = view.getUint16(off);
        if ((marker & 0xFF00) !== 0xFF00) break;
        if (marker === 0xFFD8 || marker === 0xFFD9) { off += 2; continue; }
        const size = view.getUint16(off + 2);
        if (size < 2) break;
        if (marker === 0xFFE1 && off + 4 + 6 <= view.byteLength) {
          let sig = '';
          for (let i = 0; i < 4; i++) sig += String.fromCharCode(view.getUint8(off + 4 + i));
          if (sig === 'Exif') { tiffStart = off + 10; break; }
        }
        if (marker === 0xFFDA) break;          // 画像本体に入ったら終わり
        off += 2 + size;
      }
      if (tiffStart < 0 || tiffStart + 8 > view.byteLength) return out;

      // TIFF ヘッダ: バイト順 + マジック 42 + IFD0 へのオフセット
      const bo = view.getUint16(tiffStart);
      const le = bo === 0x4949;                 // 'II' ならリトルエンディアン
      if (!le && bo !== 0x4D4D) return out;
      if (view.getUint16(tiffStart + 2, le) !== 42) return out;
      const ifd0 = tiffStart + view.getUint32(tiffStart + 4, le);

      const entries = readIFD(view, tiffStart, ifd0, le);
      if (!entries) return out;

      const dt = entries.get(TAG_DATETIME);
      if (dt) out.takenAt = toDate(readValue(view, tiffStart, dt, le));

      const exifPtr = entries.get(TAG_EXIF_IFD);
      if (exifPtr) {
        const ex = readIFD(view, tiffStart, tiffStart + readValue(view, tiffStart, exifPtr, le), le);
        const dto = ex && ex.get(TAG_DATETIME_ORIGINAL);
        if (dto) {
          const v = toDate(readValue(view, tiffStart, dto, le));
          if (v) out.takenAt = v;               // 撮影日時のほうが正確なので上書き
        }
      }

      const gpsPtr = entries.get(TAG_GPS_IFD);
      if (!gpsPtr) return out;
      const gps = readIFD(view, tiffStart, tiffStart + readValue(view, tiffStart, gpsPtr, le), le);
      if (!gps) return out;

      const latRef = gps.get(1) && readValue(view, tiffStart, gps.get(1), le);
      const latVal = gps.get(2) && readValue(view, tiffStart, gps.get(2), le);
      const lngRef = gps.get(3) && readValue(view, tiffStart, gps.get(3), le);
      const lngVal = gps.get(4) && readValue(view, tiffStart, gps.get(4), le);

      if (Array.isArray(latVal) && latVal.length >= 3 && Array.isArray(lngVal) && lngVal.length >= 3) {
        const lat = dms(latVal, String(latRef || 'N').trim());
        const lng = dms(lngVal, String(lngRef || 'E').trim());
        if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
            && !(lat === 0 && lng === 0)) {
          out.lat = lat; out.lng = lng;
        }
      }

      const altRef = gps.get(5) ? readValue(view, tiffStart, gps.get(5), le) : 0;
      const alt = gps.get(6) ? readValue(view, tiffStart, gps.get(6), le) : null;
      if (typeof alt === 'number' && isFinite(alt)) out.altitude = altRef === 1 ? -alt : alt;

    } catch (e) { /* 壊れた EXIF は「無い」ものとして扱う */ }
    return out;
  }

  function readIFD(view, tiffStart, ifdOff, le) {
    if (ifdOff < 0 || ifdOff + 2 > view.byteLength) return null;
    const n = view.getUint16(ifdOff, le);
    if (n > 512) return null;                    // 明らかに壊れている
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > view.byteLength) break;
      map.set(view.getUint16(e, le), {
        type: view.getUint16(e + 2, le),
        count: view.getUint32(e + 4, le),
        at: e + 8,
      });
    }
    return map;
  }

  function readValue(view, tiffStart, entry, le) {
    const size = TYPE_SIZE[entry.type];
    if (!size) return null;
    const total = size * entry.count;
    // 4バイトに収まらない値は、その場所にオフセットが入っている
    let p = total <= 4 ? entry.at : tiffStart + view.getUint32(entry.at, le);
    if (p < 0 || p + total > view.byteLength) return null;

    if (entry.type === 2) {                      // ASCII
      let s = '';
      for (let i = 0; i < entry.count; i++) {
        const c = view.getUint8(p + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }

    const vals = [];
    for (let i = 0; i < entry.count; i++, p += size) {
      switch (entry.type) {
        case 1: case 7: vals.push(view.getUint8(p)); break;
        case 3: vals.push(view.getUint16(p, le)); break;
        case 4: vals.push(view.getUint32(p, le)); break;
        case 9: vals.push(view.getInt32(p, le)); break;
        case 5: {
          const d = view.getUint32(p + 4, le);
          vals.push(d === 0 ? 0 : view.getUint32(p, le) / d); break;
        }
        case 10: {
          const d = view.getInt32(p + 4, le);
          vals.push(d === 0 ? 0 : view.getInt32(p, le) / d); break;
        }
      }
    }
    return vals.length === 1 ? vals[0] : vals;
  }

  function dms(v, ref) {
    const deg = Math.abs(v[0]) + (v[1] || 0) / 60 + (v[2] || 0) / 3600;
    return (ref === 'S' || ref === 'W') ? -deg : deg;
  }

  /** EXIF の "2026:08:27 09:30:00" を時刻(ミリ秒)に直す */
  function toDate(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return isFinite(t) ? t : null;
  }

  global.Exif = { parse };

})(typeof window !== 'undefined' ? window : globalThis);
