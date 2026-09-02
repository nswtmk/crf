'use strict';

/* =========================================================================
   app.js — 足あと地図
   行った場所を記録し、まだ行っていない場所を霧で覆って見せる。
   ========================================================================= */

const G = window.Geo;
const $ = s => document.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

const KEY_PREFS = 'trailmap-prefs-v1';
const PHOTO_MAX = 1600;          // 保存する写真の最大辺 (端末を圧迫しないため)

let map = null;
let visits = [];
let others = [];                 // 他の人の記録 (読むだけ)
let supa = null, social = null;
let cells = new Set();           // 踏破ずみのマス "x,y"
let editing = null;              // 編集中の記録
let pickMode = false;
let prefs = { grid: 15, fog: true, autofog: true, lat: 35.681236, lng: 139.767125, zoom: 13 };
let objectUrls = [];

/* ---------- 設定の保存 ---------------------------------------------------- */

function savePrefs() {
  try { localStorage.setItem(KEY_PREFS, JSON.stringify(prefs)); }
  catch (e) { /* 保存できなくても動作には支障がない */ }
}
function loadPrefs() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY_PREFS) || 'null');
    if (d && typeof d === 'object') Object.assign(prefs, d);
  } catch (e) { /* 壊れていたら既定値で始める */ }
}

/* ---------- 踏破マスの計算 ------------------------------------------------ */

function rebuildCells() {
  // 霧が晴れるのは自分が行った場所だけ。他人の記録では晴らさない。
  cells = new Set();
  for (const v of visits) {
    const c = G.cellOf(v.lat, v.lng, prefs.grid);
    if (prefs.autofog) {
      // 点だけだと霧が晴れた実感が乏しいので、周り1マスも開ける
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) cells.add((c.x + dx) + ',' + (c.y + dy));
    } else {
      cells.add(c.x + ',' + c.y);
    }
  }
  $('#b-cells').textContent = cells.size;
}

/* ---------- 霧の描画 ------------------------------------------------------
   画面全体を霧で塗ってから、踏破ずみのマスだけをくり抜く。
   未踏マスを一つずつ描くより圧倒的に速い。
   ------------------------------------------------------------------------ */

function drawFog(ctx, m) {
  if (!prefs.fog) return;
  const { w, h } = m.size;
  const tz = m.tileZoom, s = m.scale;
  const gz = prefs.grid;
  const cx = G.lngToX(m.center.lng, tz), cy = G.latToY(m.center.lat, tz);

  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  ctx.fillStyle = dark ? 'rgba(8,12,22,.82)' : 'rgba(40,52,74,.62)';
  ctx.fillRect(0, 0, w, h);

  // グリッド1マスが画面上で何ピクセルになるか
  const cellPx = G.TILE * Math.pow(2, tz - gz) * s;
  if (cellPx < 1.2) return;      // 細かすぎて意味をなさないので、そのまま霧のまま

  // destination-out は「塗る色の不透明度のぶんだけ」消す。霧の色のまま消しにいくと
  // 0.62 ぶんしか消えず、踏破ずみの場所が曇ったまま残る。完全な不透明色で消す。
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  const factor = G.TILE * Math.pow(2, tz - gz);
  const pad = 0.5;               // マスの継ぎ目に線が残らないよう少し重ねる
  for (const key of cells) {
    const i = key.indexOf(',');
    const gx = +key.slice(0, i), gy = +key.slice(i + 1);
    const x = (gx * factor - cx) * s + w / 2;
    const y = (gy * factor - cy) * s + h / 2;
    if (x > w + cellPx || y > h + cellPx || x + cellPx < 0 || y + cellPx < 0) continue;
    ctx.fillRect(x - pad, y - pad, cellPx + pad * 2, cellPx + pad * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* ---------- マーカー ------------------------------------------------------ */

function refreshMarkers() {
  const mine = visits.map(v => {
    const d = el('button', 'pin' + ((v.photos || []).length ? ' haspin' : ''));
    d.title = v.title || '記録';
    if (v.visibility !== 'private') d.classList.add('shared');
    d.addEventListener('click', ev => { ev.stopPropagation(); openEdit(v); });
    return { lat: v.lat, lng: v.lng, el: d };
  });
  // 他の人の記録は、自分のものと見分けがつく形にする
  const theirs = others.map(o => {
    const d = el('button', 'pin other');
    d.title = (o.author.nickname || '') + ': ' + (o.title || '記録');
    const face = el('span', 'otherface');
    face.textContent = o.author.icon_emoji || '👤';
    face.style.background = o.author.icon_color || '#666';
    d.append(face);
    d.addEventListener('click', ev => { ev.stopPropagation(); openOther(o); });
    return { lat: o.lat, lng: o.lng, el: d };
  });
  map.setMarkers(mine.concat(theirs));
}

/** 他の人の記録を読むだけの表示 */
function openOther(o) {
  window.SocialUI.setCurrentOther(o);
  $('#o-icon').textContent = o.author.icon_emoji || '👤';
  $('#o-icon').style.background = o.author.icon_color || '#666';
  $('#o-author').textContent = o.author.nickname || '(不明)';
  $('#o-when').textContent = new Date(o.ts).toLocaleDateString('ja-JP') +
    ' · ' + (o.visibility === 'public' ? '全体に公開' : '友達だけ');
  $('#other-title').textContent = o.title || '(名前なし)';
  $('#o-comment').textContent = o.comment || '';
  $('#o-comment').classList.toggle('hidden', !o.comment);
  $('#o-coords').textContent = o.lat.toFixed(5) + ', ' + o.lng.toFixed(5);
  $('#o-goto').onclick = () => {
    hide('#other-bg');
    map.setView(o.lat, o.lng, Math.max(map.zoom, 15));
  };
  show('#other-bg');
}

/* ---------- 記録の読み込み ------------------------------------------------ */

async function reload() {
  visits = await Store.allVisits();
  rebuildCells();
  refreshMarkers();
  map.schedule();
}

/** 他の人の記録を取り直す。何が見えるかはサーバー側が決める。 */
async function reloadOthers() {
  if (!social || !supa || !supa.signedIn) {
    if (others.length) { others = []; refreshMarkers(); map.schedule(); }
    return;
  }
  try {
    others = await social.fetchOthers(300);
  } catch (e) {
    others = [];
  }
  refreshMarkers();
  map.schedule();
}

/** 端末の記録をまとめてサーバーへ反映する */
async function syncAll() {
  if (!social || !supa || !supa.signedIn) { toast('先にログインしてください'); return; }
  const targets = visits.filter(v => v.visibility !== 'private' || v.remoteId);
  if (!targets.length) { toast('共有する設定の記録がありません'); return; }
  toast('同期しています…');
  let failed = 0;
  const map2 = await social.pushAll(targets, (done, total, err) => { if (err) failed++; });
  for (const v of targets) {
    if (Object.prototype.hasOwnProperty.call(map2, v.id)) {
      v.remoteId = map2[v.id];
      await Store.putVisit(v);
    }
  }
  await reload();
  await reloadOthers();
  toast(failed ? (targets.length - failed) + '件を同期 (' + failed + '件は失敗)' : targets.length + '件を同期しました');
}

/* ---------- 編集シート ---------------------------------------------------- */

function openEdit(visit, at) {
  editing = visit
    ? Object.assign({}, visit, { photos: (visit.photos || []).slice() })
    : { id: Store.uid(), lat: at.lat, lng: at.lng, ts: Date.now(), title: '', comment: '',
        photos: [], visibility: window.Visibility.DEFAULT_VIS, remoteId: null };

  $('#edit-title').textContent = visit ? '記録を編集' : 'ここを記録';
  $('#edit-coords').textContent = editing.lat.toFixed(5) + ', ' + editing.lng.toFixed(5);
  $('#f-title').value = editing.title || '';
  $('#f-comment').value = editing.comment || '';
  $('#f-date').value = toLocalInput(editing.ts);
  $('#f-delete').classList.toggle('hidden', !visit);
  $('#exif-hint').textContent = '';
  renderVisibility();
  renderPhotoStrip();
  show('#edit-bg');
}

/** 公開範囲の3択。既定は「自分だけ」で、それ以外を選ぶと何が起きるかを明記する。 */
function renderVisibility() {
  const V = window.Visibility;
  const box = $('#f-vis');
  box.textContent = '';
  for (const key of V.VIS_ORDER) {
    const v = V.VIS[key];
    const b = el('button', 'visbtn' + (editing.visibility === key ? ' on' : ''));
    b.type = 'button';
    b.innerHTML = '';
    const i = el('span', 'visicon'); i.textContent = v.icon;
    const l = el('span'); l.textContent = v.label;
    b.append(i, l);
    b.addEventListener('click', () => { editing.visibility = key; renderVisibility(); });
    box.append(b);
  }
  const hint = $('#vis-hint');
  const signedIn = supa && supa.signedIn;
  if (editing.visibility === 'private') {
    hint.textContent = 'この記録は端末の中だけに残り、サーバーには送りません。';
    hint.classList.remove('err');
  } else if (!signedIn) {
    hint.textContent = 'ログインするまでは共有されません。端末の中だけに残ります。';
    hint.classList.add('err');
  } else if (editing.visibility === 'friends') {
    hint.textContent = 'おたがいにフォローしている相手だけが見られます。';
    hint.classList.remove('err');
  } else {
    hint.textContent = '誰でも見られます。自宅や職場が分かる場所は避けてください。';
    hint.classList.add('err');
  }
}

function toLocalInput(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function renderPhotoStrip() {
  const box = $('#f-photos');
  box.textContent = '';
  for (const pid of editing.photos) {
    const rec = await Store.getPhoto(pid);
    if (!rec) continue;
    const url = URL.createObjectURL(rec.blob);
    objectUrls.push(url);
    const wrap = el('div', 'thumb');
    const img = el('img'); img.src = url; img.alt = '';
    img.addEventListener('click', () => openViewer(url));
    const rm = el('button', 'rmphoto'); rm.textContent = '×'; rm.title = 'この写真を外す';
    rm.addEventListener('click', () => {
      editing.photos = editing.photos.filter(x => x !== pid);
      Store.delPhoto(pid);
      renderPhotoStrip();
    });
    wrap.append(img, rm);
    box.append(wrap);
  }
  if (!editing.photos.length) {
    const p = el('span', 'nophoto'); p.textContent = 'まだありません';
    box.append(p);
  }
}

/** 写真を縮めて保存する。元のままだと端末の容量をすぐ使い切るため。 */
function shrink(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, PHOTO_MAX / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob(b => resolve(b || file), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function addPhotos(files) {
  let found = null;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    // 位置情報を先に見る (縮小すると EXIF は失われるため)
    try {
      const info = Exif.parse(await file.arrayBuffer());
      if (info.lat != null && !found) found = info;
    } catch (e) { /* 読めなくても写真は保存する */ }
    const blob = await shrink(file);
    const pid = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await Store.putPhoto(pid, blob);
    editing.photos.push(pid);
  }
  await renderPhotoStrip();

  if (found) {
    const dist = Math.round(G.distance(editing.lat, editing.lng, found.lat, found.lng));
    const hint = $('#exif-hint');
    hint.textContent = '';
    const msg = el('span');
    msg.textContent = '写真に位置情報がありました(' +
      (dist >= 1000 ? (dist / 1000).toFixed(1) + 'km' : dist + 'm') + '離れた場所)。';
    const b = el('button', 'linkbtn');
    b.textContent = 'この位置に合わせる';
    b.addEventListener('click', () => {
      editing.lat = found.lat; editing.lng = found.lng;
      if (found.takenAt) { editing.ts = found.takenAt; $('#f-date').value = toLocalInput(editing.ts); }
      $('#edit-coords').textContent = editing.lat.toFixed(5) + ', ' + editing.lng.toFixed(5);
      hint.textContent = '写真の位置に合わせました。';
    });
    hint.append(msg, ' ', b);
  }
}

async function saveEdit() {
  editing.title = $('#f-title').value.trim();
  editing.comment = $('#f-comment').value.trim();
  const d = $('#f-date').value;
  if (d) { const t = new Date(d).getTime(); if (isFinite(t)) editing.ts = t; }
  await Store.putVisit(editing);
  const saved = editing;
  hide('#edit-bg');
  editing = null;
  await reload();
  toast('保存しました');

  // 共有する設定なら、この1件だけをサーバーへ反映する
  if (social && supa && supa.signedIn) {
    try {
      const r = await social.pushVisit(saved);
      if (r && r.remoteId) { saved.remoteId = r.remoteId; await Store.putVisit(saved); }
      if (r && r.removed)  { saved.remoteId = null;       await Store.putVisit(saved); }
    } catch (e) {
      toast('共有できませんでした: ' + e.message);
    }
  }
}

/* ---------- 一覧 ---------------------------------------------------------- */

async function openList() {
  const box = $('#list');
  box.textContent = '';

  const st = $('#stats');
  st.textContent = '';
  const stat = (lab, val, note) => {
    const d = el('div', 'stat');
    const l = el('span', 'lab'); l.textContent = lab;
    const v = el('span', 'val'); v.textContent = val;
    d.append(l, v);
    if (note) { const n = el('span', 'note'); n.textContent = note; d.append(n); }
    return d;
  };
  const photoCount = visits.reduce((s, v) => s + (v.photos || []).length, 0);
  const km2 = cells.size * Math.pow(G.cellMeters(map.center.lat, prefs.grid) / 1000, 2);
  st.append(stat('記録した場所', visits.length + '件'));
  st.append(stat('踏破したマス', cells.size, 'およそ ' + km2.toFixed(1) + ' km²'));
  st.append(stat('写真', photoCount + '枚'));
  if (visits.length) {
    const oldest = visits[visits.length - 1];
    st.append(stat('最初の記録', new Date(oldest.ts).toLocaleDateString('ja-JP')));
  }

  if (!visits.length) {
    const p = el('p', 'hint');
    p.textContent = 'まだ記録がありません。「いまここに記録」から始めてください。';
    box.append(p);
  }

  for (const v of visits) {
    const row = el('button', 'listrow');
    const thumb = el('div', 'lthumb');
    if ((v.photos || []).length) {
      const rec = await Store.getPhoto(v.photos[0]);
      if (rec) {
        const url = URL.createObjectURL(rec.blob);
        objectUrls.push(url);
        const img = el('img'); img.src = url; img.alt = '';
        thumb.append(img);
      }
    } else thumb.textContent = '📍';

    const body = el('div', 'lbody');
    const t = el('div', 'ltitle');
    t.textContent = v.title || '(名前なし)';
    const meta = el('div', 'lmeta');
    meta.textContent = new Date(v.ts).toLocaleDateString('ja-JP') +
      ((v.photos || []).length ? ' · 写真' + v.photos.length + '枚' : '');
    body.append(t, meta);
    if (v.comment) {
      const c = el('div', 'lcomment'); c.textContent = v.comment;
      body.append(c);
    }
    row.append(thumb, body);
    row.addEventListener('click', () => {
      hide('#list-bg');
      map.setView(v.lat, v.lng, Math.max(map.zoom, 15));
      openEdit(v);
    });
    box.append(row);
  }
  show('#list-bg');
}

/* ---------- 設定 ---------------------------------------------------------- */

function syncMenu() {
  const sel = $('#s-grid');
  sel.textContent = '';
  for (const lv of G.GRID_LEVELS) {
    const o = el('option'); o.value = lv.zoom;
    o.textContent = lv.label + '(約' + fmtM(G.cellMeters(map ? map.center.lat : 35.7, lv.zoom)) + '四方)';
    sel.append(o);
  }
  sel.value = prefs.grid;
  $('#s-autofog').checked = prefs.autofog;
  updateGridHint();
  Store.usage().then(u => {
    $('#usage-hint').textContent = u
      ? '使用量: 約' + (u.used / 1048576).toFixed(1) + 'MB' +
        (u.quota ? ' / 使える上限 約' + (u.quota / 1048576).toFixed(0) + 'MB' : '')
      : '';
  });
}
function fmtM(m) { return m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm'; }
function updateGridHint() {
  $('#grid-hint').textContent = '細かくすると「行った」と言える範囲が狭くなり、霧が晴れにくくなります。' +
    '現在: 1マス 約' + fmtM(G.cellMeters(map ? map.center.lat : 35.7, prefs.grid)) + '四方。';
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function doExport(withPhotos) {
  toast('書き出しています…');
  const data = await Store.exportAll(withPhotos);
  const stamp = new Date().toISOString().slice(0, 10);
  // ファイル名は ASCII にする。日本語を入れるとブラウザが名前ごと捨てて
  // 拡張子の無い "download" になり、読み込み直せなくなる。
  download('trailmap-' + stamp + (withPhotos ? '' : '-nophoto') + '.json', JSON.stringify(data));
  toast('書き出しました');
}

/* ---------- 現在地 -------------------------------------------------------- */

function locate() {
  if (!navigator.geolocation) { toast('この端末では現在地を取得できません'); return Promise.reject(); }
  toast('現在地を調べています…');
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      err => {
        toast(err.code === 1 ? '位置情報の利用が許可されていません'
            : err.code === 3 ? '現在地の取得に時間がかかっています'
            : '現在地を取得できませんでした');
        reject(err);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
}

/* ---------- こまごま ------------------------------------------------------ */

function show(sel) { $(sel).classList.remove('hidden'); }
function hide(sel) { $(sel).classList.add('hidden'); }

let toastTimer = null;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = el('div'); t.id = 'toast'; t.className = 'toast'; document.body.append(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

function openViewer(url) { $('#viewer-img').src = url; show('#viewer'); }

/** 記録シートが開いている間にログイン状態が変わったら、注意書きを出し直す */
function renderVisibilityHintIfOpen() {
  if (editing && !$('#edit-bg').classList.contains('hidden')) renderVisibility();
}

function updateSyncHint() {
  const n = visits.filter(v => v.visibility !== 'private').length;
  const priv = visits.length - n;
  $('#sync-hint').textContent = supa && supa.signedIn
    ? '共有する設定の記録 ' + n + '件 / 端末だけの記録 ' + priv + '件。' +
      '「自分だけ」の記録はサーバーに送りません。'
    : '';
}

function setPickMode(on) {
  pickMode = on;
  $('#crosshair').classList.toggle('hidden', !on);
  $('#b-pick').classList.toggle('active', on);
  $('#b-pick').textContent = on ? 'ここに決定' : '地図で指定';
}

/* ---------- 起動 ---------------------------------------------------------- */

async function boot() {
  loadPrefs();

  // 接続先が未設定でも、アプリはこれまでどおり端末内だけで動く
  const conf = window.SupaConfig.load();
  supa = new window.Supa(conf ? conf.url : '', conf ? conf.anonKey : '');
  social = new window.Social(supa);

  map = new MiniMap($('#map'), {
    center: { lat: prefs.lat, lng: prefs.lng },
    zoom: prefs.zoom,
    minZoom: 2, maxZoom: 19,
  });
  map.setFogRenderer(drawFog);
  map.on('moveend', () => {
    prefs.lat = map.center.lat; prefs.lng = map.center.lng; prefs.zoom = map.zoom;
    savePrefs();
  });
  map.on('tap', ll => { if (!pickMode) openEdit(null, ll); });

  $('#b-locate').addEventListener('click', async () => {
    try {
      const p = await locate();
      map.setView(p.lat, p.lng, Math.max(map.zoom, 16));
    } catch (e) { /* toast で通知ずみ */ }
  });

  $('#b-fog').addEventListener('click', () => {
    prefs.fog = !prefs.fog;
    $('#b-fog').setAttribute('aria-pressed', String(prefs.fog));
    $('#b-fog').classList.toggle('off', !prefs.fog);
    savePrefs(); map.schedule();
  });
  $('#b-fog').classList.toggle('off', !prefs.fog);
  $('#b-fog').setAttribute('aria-pressed', String(prefs.fog));

  $('#b-zin').addEventListener('click', () => {
    const { w, h } = map.size; map.zoomAround(w / 2, h / 2, Math.round(map.zoom) + 1);
  });
  $('#b-zout').addEventListener('click', () => {
    const { w, h } = map.size; map.zoomAround(w / 2, h / 2, Math.round(map.zoom) - 1);
  });

  $('#b-here').addEventListener('click', async () => {
    try {
      const p = await locate();
      map.setView(p.lat, p.lng, Math.max(map.zoom, 16));
      openEdit(null, { lat: p.lat, lng: p.lng });
    } catch (e) { /* toast で通知ずみ */ }
  });

  $('#b-pick').addEventListener('click', () => {
    if (pickMode) { setPickMode(false); openEdit(null, { lat: map.center.lat, lng: map.center.lng }); }
    else { setPickMode(true); toast('地図を動かして場所を合わせてください'); }
  });

  $('#b-list').addEventListener('click', openList);
  $('#badge').addEventListener('click', openList);
  $('#list-close').addEventListener('click', () => hide('#list-bg'));

  $('#b-menu').addEventListener('click', () => { syncMenu(); show('#menu-bg'); });
  $('#menu-close').addEventListener('click', () => hide('#menu-bg'));

  $('#s-grid').addEventListener('change', e => {
    prefs.grid = +e.target.value; savePrefs();
    updateGridHint(); rebuildCells(); map.schedule();
  });
  $('#s-autofog').addEventListener('change', e => {
    prefs.autofog = e.target.checked; savePrefs();
    rebuildCells(); map.schedule();
  });

  $('#f-save').addEventListener('click', saveEdit);
  $('#f-cancel').addEventListener('click', () => { hide('#edit-bg'); editing = null; });
  $('#f-delete').addEventListener('click', async () => {
    if (!editing) return;
    if (!confirm('この記録を消します。元に戻せません。よろしいですか?')) return;
    if (editing.remoteId && social && supa && supa.signedIn) {
      try { await social.deleteRemote(editing); }
      catch (e) { if (!confirm('サーバー側を消せませんでした (' + e.message + ')。端末からだけ消しますか?')) return; }
    }
    for (const pid of (editing.photos || [])) await Store.delPhoto(pid);
    await Store.delVisit(editing.id);
    hide('#edit-bg'); editing = null;
    await reload();
    toast('消しました');
  });
  $('#f-file').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) { toast('写真を取り込んでいます…'); await addPhotos(files); }
  });

  $('#s-export').addEventListener('click', () => doExport(true));
  $('#s-export-light').addEventListener('click', () => doExport(false));
  $('#s-import').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const mode = confirm('いまの記録に「足す」場合は OK、\n「入れ替える」場合はキャンセルを押してください。')
        ? 'merge' : 'replace';
      if (mode === 'replace' && !confirm('いまの記録をすべて消して入れ替えます。よろしいですか?')) return;
      const n = await Store.importAll(data, mode);
      await reload();
      toast(n + '件を読み込みました');
    } catch (err) {
      alert('読み込めませんでした: ' + err.message);
    }
  });
  $('#s-clear').addEventListener('click', async () => {
    if (!confirm('記録と写真をすべて消します。元に戻せません。よろしいですか?')) return;
    if (!confirm('本当に消してよいですか? 先に書き出しておくことをおすすめします。')) return;
    await Store.clearAll();
    await reload();
    hide('#menu-bg');
    toast('すべて消しました');
  });

  $('#viewer-close').addEventListener('click', () => hide('#viewer'));
  $('#viewer').addEventListener('click', e => { if (e.target.id === 'viewer') hide('#viewer'); });

  for (const id of ['edit-bg', 'list-bg', 'menu-bg']) {
    $('#' + id).addEventListener('click', e => { if (e.target.id === id) hide('#' + id); });
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    for (const id of ['edit-bg', 'list-bg', 'menu-bg', 'viewer']) hide('#' + id);
    if (pickMode) setPickMode(false);
  });

  window.SocialUI.init({
    supa, social,
    onChanged: async () => {
      renderVisibilityHintIfOpen();
      try { await social.loadBlocks(); } catch (e) { /* 圏外なら後で読み直す */ }
      await reloadOthers();
      updateSyncHint();
    },
  });
  $('#a-sync').addEventListener('click', syncAll);

  await reload();

  // ログイン済みなら、自分の情報と他の人の記録を裏で読み込む
  if (supa.signedIn) {
    (async () => {
      try {
        await social.loadMe();
        await social.loadFollows();
        await social.loadBlocks();
        window.SocialUI.refreshAvatar();
        await reloadOthers();
        updateSyncHint();
      } catch (e) { /* 圏外でも端末内の記録は使える */ }
    })();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}

document.addEventListener('DOMContentLoaded', boot);
