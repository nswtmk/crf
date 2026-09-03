'use strict';

/* =========================================================================
   supa.js — Supabase への最小限の接続口
   公式のライブラリは読み込まず、fetch だけで話す。外部スクリプトに依存しない
   ぶん、CDN が落ちてもオフラインでもアプリ本体は起動できる。
   ========================================================================= */

(function (global) {

  const KEY_SESSION = 'trailmap-session-v1';

  class Supa {
    constructor(url, anonKey) {
      this.url = String(url || '').replace(/\/+$/, '');
      this.anonKey = anonKey || '';
      this.session = null;
      this._load();
    }

    get configured() { return !!(this.url && this.anonKey); }
    get signedIn() { return !!(this.session && this.session.access_token); }
    get userId() { return this.session ? this.session.user_id : null; }

    /* ---------- 手元に持つセッション ---------- */

    _load() {
      try {
        const d = JSON.parse(localStorage.getItem(KEY_SESSION) || 'null');
        if (d && d.access_token) this.session = d;
      } catch (e) { /* 壊れていたら未ログイン扱い */ }
    }
    _save() {
      try {
        if (this.session) localStorage.setItem(KEY_SESSION, JSON.stringify(this.session));
        else localStorage.removeItem(KEY_SESSION);
      } catch (e) { /* 保存できなくてもその場では動く */ }
    }
    _setSession(d) {
      if (!d || !d.access_token) return null;
      this.session = {
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: Date.now() + (d.expires_in || 3600) * 1000,
        user_id: d.user && d.user.id,
        email: d.user && d.user.email,
      };
      this._save();
      return this.session;
    }

    _headers(extra) {
      const h = Object.assign({ apikey: this.anonKey, 'Content-Type': 'application/json' }, extra || {});
      // 未ログインでも Authorization を付ける。公式ライブラリと同じ振る舞いで、
      // apikey だけだと構成によっては素通しされないことがある。
      h.Authorization = 'Bearer ' + (this.signedIn ? this.session.access_token : this.anonKey);
      return Object.assign(h, extra || {});
    }

    /** ログイン前に使うヘッダ。キーそのものを持ち主として名乗る。 */
    _publicHeaders() {
      return {
        apikey: this.anonKey,
        Authorization: 'Bearer ' + this.anonKey,
        'Content-Type': 'application/json',
      };
    }

    /** 期限が近ければ更新する。失敗したらログアウト扱い。 */
    async ensureFresh() {
      if (!this.signedIn) return false;
      if (Date.now() < this.session.expires_at - 60000) return true;
      try {
        const res = await fetch(this.url + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: this._publicHeaders(),
          body: JSON.stringify({ refresh_token: this.session.refresh_token }),
        });
        if (!res.ok) throw new Error('refresh failed');
        this._setSession(await res.json());
        return true;
      } catch (e) {
        this.session = null; this._save();
        return false;
      }
    }

    /* ---------- ログイン ---------- */

    async signUp(email, password) {
      const res = await fetch(this.url + '/auth/v1/signup', {
        method: 'POST',
        headers: this._publicHeaders(),
        body: JSON.stringify({ email, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(authMessage(d, res.status));
      // メール確認が要る設定だと、この時点ではトークンが返らない
      return this._setSession(d) ? { signedIn: true } : { signedIn: false, needsEmail: true };
    }

    async signIn(email, password) {
      const res = await fetch(this.url + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: this._publicHeaders(),
        body: JSON.stringify({ email, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(authMessage(d, res.status));
      this._setSession(d);
      return { signedIn: true };
    }

    async signOut() {
      try {
        if (this.signedIn) {
          await fetch(this.url + '/auth/v1/logout', { method: 'POST', headers: this._headers() });
        }
      } catch (e) { /* 通信できなくても手元は消す */ }
      this.session = null;
      this._save();
    }

    /* ---------- テーブル操作 ---------- */

    async rest(path, opts) {
      opts = opts || {};
      await this.ensureFresh();
      const res = await fetch(this.url + '/rest/v1/' + path, {
        method: opts.method || 'GET',
        headers: this._headers(opts.headers),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 204) return null;
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!res.ok) {
        const msg = (data && (data.message || data.hint || data.error_description)) || ('通信に失敗しました (' + res.status + ')');
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return data;
    }

    select(table, query) { return this.rest(table + (query ? '?' + query : '')); }

    insert(table, rows, opts) {
      opts = opts || {};
      const pref = ['return=representation'];
      if (opts.upsert) pref.push('resolution=merge-duplicates');
      return this.rest(table + (opts.onConflict ? '?on_conflict=' + opts.onConflict : ''),
        { method: 'POST', body: rows, headers: { Prefer: pref.join(',') } });
    }

    update(table, query, patch) {
      return this.rest(table + '?' + query,
        { method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' } });
    }

    remove(table, query) { return this.rest(table + '?' + query, { method: 'DELETE' }); }

    rpc(fn, args) { return this.rest('rpc/' + fn, { method: 'POST', body: args || {} }); }

    /* ---------- 写真の置き場 ---------- */

    async upload(path, blob, bucket) {
      await this.ensureFresh();
      const res = await fetch(this.url + '/storage/v1/object/' + (bucket || 'photos') + '/' + path, {
        method: 'POST',
        headers: {
          apikey: this.anonKey,
          Authorization: 'Bearer ' + (this.session ? this.session.access_token : this.anonKey),
          'Content-Type': blob.type || 'image/jpeg',
          'x-upsert': 'true',
        },
        body: blob,
      });
      if (!res.ok) throw new Error('写真を送れませんでした (' + res.status + ')');
      return path;
    }

    /** 公開バケットの中身は、そのまま <img src> に渡せる URL になる */
    publicUrl(path, bucket) {
      return this.url + '/storage/v1/object/public/' + (bucket || 'avatars') + '/' + path;
    }

    async download(path) {
      await this.ensureFresh();
      const res = await fetch(this.url + '/storage/v1/object/photos/' + path, {
        headers: {
          apikey: this.anonKey,
          Authorization: 'Bearer ' + (this.session ? this.session.access_token : this.anonKey),
        },
      });
      if (!res.ok) return null;
      return res.blob();
    }

    async removeFile(path, bucket) {
      await this.ensureFresh();
      await fetch(this.url + '/storage/v1/object/' + (bucket || 'photos') + '/' + path, {
        method: 'DELETE', headers: this._headers(),
      }).catch(() => {});
    }
  }

  /** Supabase が返すエラーを、そのまま出しても意味が通る日本語にする */
  function authMessage(d, status) {
    const raw = String((d && (d.msg || d.message || d.error_description || d.error)) || '');
    if (/already registered|already exists/i.test(raw)) return 'このメールアドレスは登録済みです。ログインしてください。';
    if (/invalid login|invalid credentials/i.test(raw)) return 'メールアドレスかパスワードが違います。';
    if (/password/i.test(raw) && /least|short/i.test(raw)) return 'パスワードは6文字以上にしてください。';
    if (/email/i.test(raw) && /invalid/i.test(raw)) return 'メールアドレスの形式が正しくありません。';
    if (/rate limit|too many/i.test(raw)) return '試行が多すぎます。しばらく待ってからやり直してください。';
    if (status === 0 || !raw) return '接続できませんでした。通信状況を確認してください。';
    return raw;
  }

  /* ---------- 接続先の設定 ----------
     プロジェクトURLと anon キーは、公開ページに置いて構わないもの。
     実際の保護は上の RLS が行う。ただし取り違え防止のため保存はしておく。
     ------------------------------------------------------------------ */
  const KEY_CONF = 'trailmap-supabase-v1';

  function loadConfig() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY_CONF) || 'null');
      if (d && d.url && d.anonKey) return d;
    } catch (e) { /* 未設定として扱う */ }
    return (global.TRAILMAP_SUPABASE && global.TRAILMAP_SUPABASE.url)
      ? global.TRAILMAP_SUPABASE : null;
  }

  function saveConfig(url, anonKey) {
    try { localStorage.setItem(KEY_CONF, JSON.stringify({ url, anonKey })); } catch (e) {}
  }
  function clearConfig() { try { localStorage.removeItem(KEY_CONF); } catch (e) {} }

  global.Supa = Supa;
  global.SupaConfig = { load: loadConfig, save: saveConfig, clear: clearConfig, KEY_CONF, KEY_SESSION };

})(typeof window !== 'undefined' ? window : globalThis);
