'use strict';

/* =========================================================================
   minimap.js — 小さなスリッピーマップ
   外部ライブラリを使わずに、タイルの表示・ドラッグ・ピンチズームだけを行う。
   依存を持たないので、オフラインでも確実に動く。
   ========================================================================= */

(function (global) {

  const G = global.Geo;
  const TILE = G.TILE;

  class MiniMap {
    constructor(container, opts) {
      opts = opts || {};
      this.el = container;
      this.minZoom = opts.minZoom != null ? opts.minZoom : 2;
      this.maxZoom = opts.maxZoom != null ? opts.maxZoom : 19;
      this.tileUrl = opts.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
      this.center = opts.center || { lat: 35.681236, lng: 139.767125 };
      this.zoom = opts.zoom != null ? opts.zoom : 13;

      this.el.classList.add('mm');
      this.tilePane   = div('mm-pane mm-tiles');
      this.fogCanvas  = document.createElement('canvas');
      this.fogCanvas.className = 'mm-pane mm-fog';
      this.markerPane = div('mm-pane mm-markers');
      this.el.append(this.tilePane, this.fogCanvas, this.markerPane);

      this._tiles = new Map();       // "z/x/y" → img
      this._markers = [];
      this._handlers = {};
      this._raf = null;
      this._fogDraw = null;          // 霧の描画関数 (アプリ側から差し込む)

      this._bindPointer();
      this._observeSize();
      this.render();
    }

    /* ---------- 変換 ---------- */

    get size() { return { w: this.el.clientWidth, h: this.el.clientHeight }; }
    get tileZoom() { return G.clamp(Math.round(this.zoom), this.minZoom, this.maxZoom); }
    get scale() { return Math.pow(2, this.zoom - this.tileZoom); }

    /** 緯度経度 → 画面上のピクセル (コンテナ左上が原点) */
    project(lat, lng) {
      const tz = this.tileZoom, s = this.scale, { w, h } = this.size;
      const cx = G.lngToX(this.center.lng, tz), cy = G.latToY(this.center.lat, tz);
      return {
        x: (G.lngToX(lng, tz) - cx) * s + w / 2,
        y: (G.latToY(lat, tz) - cy) * s + h / 2,
      };
    }

    /** 画面上のピクセル → 緯度経度 */
    unproject(x, y) {
      const tz = this.tileZoom, s = this.scale, { w, h } = this.size;
      const cx = G.lngToX(this.center.lng, tz), cy = G.latToY(this.center.lat, tz);
      return {
        lat: G.yToLat((y - h / 2) / s + cy, tz),
        lng: G.xToLng((x - w / 2) / s + cx, tz),
      };
    }

    /* ---------- 操作 ---------- */

    setView(lat, lng, zoom) {
      this.center = { lat: G.clamp(lat, -G.MAX_LAT, G.MAX_LAT), lng };
      if (zoom != null) this.zoom = G.clamp(zoom, this.minZoom, this.maxZoom);
      this.schedule();
      this.emit('move');
    }

    panBy(dx, dy) {
      const tz = this.tileZoom, s = this.scale;
      const cx = G.lngToX(this.center.lng, tz) + dx / s;
      const cy = G.latToY(this.center.lat, tz) + dy / s;
      const ws = G.worldSize(tz);
      this.center = {
        lat: G.yToLat(G.clamp(cy, 0, ws), tz),
        lng: G.xToLng(cx, tz),
      };
      this.schedule();
      this.emit('move');
    }

    /** 画面上の点を固定したままズームする (ピンチと同じ挙動) */
    zoomAround(px, py, newZoom) {
      const before = this.unproject(px, py);
      this.zoom = G.clamp(newZoom, this.minZoom, this.maxZoom);
      const after = this.unproject(px, py);
      this.center = {
        lat: G.clamp(this.center.lat + (before.lat - after.lat), -G.MAX_LAT, G.MAX_LAT),
        lng: this.center.lng + (before.lng - after.lng),
      };
      this.schedule();
      this.emit('move');
    }

    /* ---------- マーカー ---------- */

    setMarkers(list) {
      // list: [{lat, lng, el}] — el はアプリ側が作った DOM
      this.markerPane.textContent = '';
      this._markers = list || [];
      for (const m of this._markers) this.markerPane.append(m.el);
      this.positionMarkers();
    }

    positionMarkers() {
      const { w, h } = this.size;
      for (const m of this._markers) {
        const p = this.project(m.lat, m.lng);
        // 画面の外に大きく出たものは描画から外す
        const out = p.x < -80 || p.y < -80 || p.x > w + 80 || p.y > h + 80;
        m.el.style.display = out ? 'none' : '';
        if (!out) m.el.style.transform = 'translate3d(' + Math.round(p.x) + 'px,' + Math.round(p.y) + 'px,0)';
      }
    }

    /** 霧の描画をアプリ側から差し込む。fn(ctx, map) が呼ばれる。 */
    setFogRenderer(fn) { this._fogDraw = fn; this.schedule(); }

    /* ---------- 描画 ---------- */

    schedule() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.render(); });
    }

    render() {
      const { w, h } = this.size;
      if (!w || !h) return;
      this.renderTiles();
      this.positionMarkers();
      this.renderFog();
    }

    renderTiles() {
      const tz = this.tileZoom, s = this.scale, { w, h } = this.size;
      const cx = G.lngToX(this.center.lng, tz), cy = G.latToY(this.center.lat, tz);
      const size = TILE * s;
      const n = Math.pow(2, tz);

      const x0 = Math.floor((cx - (w / 2) / s) / TILE);
      const x1 = Math.floor((cx + (w / 2) / s) / TILE);
      const y0 = Math.max(0, Math.floor((cy - (h / 2) / s) / TILE));
      const y1 = Math.min(n - 1, Math.floor((cy + (h / 2) / s) / TILE));

      const needed = new Set();
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const wrapX = ((x % n) + n) % n;               // 東西はぐるりと繋げる
          const key = tz + '/' + x + '/' + y;
          needed.add(key);
          let img = this._tiles.get(key);
          if (!img) {
            img = new Image();
            img.className = 'mm-tile';
            img.alt = '';
            img.decoding = 'async';
            img.loading = 'eager';
            img.addEventListener('load', () => img.classList.add('on'));
            img.addEventListener('error', () => img.classList.add('err'));
            img.src = this.tileUrl.replace('{z}', tz).replace('{x}', wrapX).replace('{y}', y);
            this._tiles.set(key, img);
            this.tilePane.append(img);
          }
          const left = (x * TILE - cx) * s + w / 2;
          const top  = (y * TILE - cy) * s + h / 2;
          img.style.width = img.style.height = size + 'px';
          img.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0)';
        }
      }

      for (const [key, img] of this._tiles) {
        if (!needed.has(key)) { img.remove(); this._tiles.delete(key); }
      }
    }

    renderFog() {
      const { w, h } = this.size;
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      if (this.fogCanvas.width !== cw || this.fogCanvas.height !== ch) {
        this.fogCanvas.width = cw; this.fogCanvas.height = ch;
        this.fogCanvas.style.width = w + 'px';
        this.fogCanvas.style.height = h + 'px';
      }
      const ctx = this.fogCanvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (this._fogDraw) this._fogDraw(ctx, this);
    }

    /* ---------- 入力 ---------- */

    _bindPointer() {
      const pts = new Map();
      let last = null, pinch = null, moved = 0, downAt = 0;

      const onDown = e => {
        this.el.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 1) { last = { x: e.clientX, y: e.clientY }; moved = 0; downAt = Date.now(); }
        else if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom };
        }
      };

      const onMove = e => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pts.size >= 2 && pinch) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch.dist > 4) {
            const r = this.el.getBoundingClientRect();
            const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
            this.zoomAround(mx, my, pinch.zoom + Math.log2(d / pinch.dist));
          }
          moved = 999;
          return;
        }
        if (!last) return;
        const dx = e.clientX - last.x, dy = e.clientY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        last = { x: e.clientX, y: e.clientY };
        this.panBy(-dx, -dy);
      };

      const onUp = e => {
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = null;
        if (pts.size === 0) {
          // 動かしていなければタップとして扱う
          if (moved < 8 && Date.now() - downAt < 700) {
            const r = this.el.getBoundingClientRect();
            this.emit('tap', this.unproject(e.clientX - r.left, e.clientY - r.top));
          }
          last = null;
          this.emit('moveend');
        } else {
          last = [...pts.values()][0];
        }
      };

      this.el.addEventListener('pointerdown', onDown);
      this.el.addEventListener('pointermove', onMove);
      this.el.addEventListener('pointerup', onUp);
      this.el.addEventListener('pointercancel', onUp);
      this.el.addEventListener('wheel', e => {
        e.preventDefault();
        const r = this.el.getBoundingClientRect();
        this.zoomAround(e.clientX - r.left, e.clientY - r.top,
                        this.zoom - Math.sign(e.deltaY) * 0.5);
        this.emit('moveend');
      }, { passive: false });
    }

    _observeSize() {
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this.schedule());
        this._ro.observe(this.el);
      } else {
        global.addEventListener('resize', () => this.schedule());
      }
    }

    /* ---------- イベント ---------- */

    on(name, fn) { (this._handlers[name] = this._handlers[name] || []).push(fn); return this; }
    emit(name, arg) { (this._handlers[name] || []).forEach(f => f(arg)); }
  }

  function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }

  global.MiniMap = MiniMap;

})(typeof window !== 'undefined' ? window : globalThis);
