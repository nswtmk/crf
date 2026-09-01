'use strict';

/* =========================================================================
   geo.js — Web メルカトルの座標変換と、未踏エリア用グリッドの計算
   地図エンジンにも霧の描画にも使う純粋な計算だけを置く。
   ========================================================================= */

(function (global) {

  const TILE = 256;
  const MAX_LAT = 85.0511287798;          // メルカトルで表現できる緯度の限界

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** ズーム z における世界全体のピクセル幅 */
  function worldSize(z) { return TILE * Math.pow(2, z); }

  /** 経度 → 世界ピクセルX */
  function lngToX(lng, z) {
    return (lng + 180) / 360 * worldSize(z);
  }

  /** 緯度 → 世界ピクセルY */
  function latToY(lat, z) {
    const l = clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    const y = Math.log(Math.tan(l) + 1 / Math.cos(l));
    return (1 - y / Math.PI) / 2 * worldSize(z);
  }

  function xToLng(x, z) {
    return x / worldSize(z) * 360 - 180;
  }

  function yToLat(y, z) {
    const n = Math.PI * (1 - 2 * y / worldSize(z));
    return Math.atan(Math.sinh(n)) * 180 / Math.PI;
  }

  /** 緯度経度 → グリッドのマス目 (指定ズームのタイル座標) */
  function cellOf(lat, lng, gridZoom) {
    return {
      x: Math.floor(lngToX(lng, gridZoom) / TILE),
      y: Math.floor(latToY(lat, gridZoom) / TILE),
    };
  }

  function cellKey(lat, lng, gridZoom) {
    const c = cellOf(lat, lng, gridZoom);
    return c.x + ',' + c.y;
  }

  /** マス目の一辺の長さ(メートル)。メルカトルなので緯度によって変わる。 */
  function cellMeters(lat, gridZoom) {
    const EARTH = 40075016.686;
    return EARTH * Math.cos(clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180) / Math.pow(2, gridZoom);
  }

  /** 2点間の距離(メートル) — ハーバサイン */
  function distance(lat1, lng1, lat2, lng2) {
    const R = 6371008.8;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 度分秒 → 十進度。EXIF の GPS はこの形式で入っている。 */
  function dmsToDeg(d, m, s, ref) {
    const v = Math.abs(d) + (m || 0) / 60 + (s || 0) / 3600;
    return (ref === 'S' || ref === 'W') ? -v : v;
  }

  const GRID_LEVELS = [
    { zoom: 13, label: 'とても粗い' },
    { zoom: 14, label: '粗い' },
    { zoom: 15, label: 'ふつう' },
    { zoom: 16, label: '細かい' },
    { zoom: 17, label: 'とても細かい' },
  ];

  global.Geo = {
    TILE, MAX_LAT, GRID_LEVELS,
    worldSize, lngToX, latToY, xToLng, yToLat,
    cellOf, cellKey, cellMeters, distance, dmsToDeg, clamp,
  };

})(typeof window !== 'undefined' ? window : globalThis);
