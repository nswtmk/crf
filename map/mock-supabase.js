/* =========================================================================
   mock-supabase.js — 検証用の Supabase もどき (開発用。配信物ではない)

   本物の代わりに立てて、アプリが正しく振る舞うかを確かめる。
   大事なのは、schema.sql の RLS と同じ「見える条件」をここでも実装している点。
   これにより「自分だけの記録が外に出ないか」「友達限定が他人に見えないか」を
   実際の通信で確かめられる。

   実行: node mock-supabase.js [ポート]
   ========================================================================= */
'use strict';
const http = require('http');
const { randomUUID } = require('crypto');

function createMock() {
  const db = { users: [], profiles: [], follows: [], blocks: [], reports: [],
               visits: [], photos: [], objects: new Map() };
  const tokens = new Map();                 // access_token → user_id

  const findUserByToken = req => {
    const auth = req.headers['authorization'] || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    return m ? (tokens.get(m[1]) || null) : null;
  };

  const isFriend = (a, b) =>
    !!a && !!b &&
    db.follows.some(f => f.follower === a && f.followee === b) &&
    db.follows.some(f => f.follower === b && f.followee === a);

  const isBlocked = (a, b) =>
    db.blocks.some(x => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a));

  /** schema.sql の visits_read と同じ条件 */
  const canSeeVisit = (viewer, v) => {
    if (v.user_id === viewer) return true;
    if (isBlocked(viewer, v.user_id)) return false;
    if (v.visibility === 'public') return true;
    return v.visibility === 'friends' && isFriend(viewer, v.user_id);
  };

  /** PostgREST 風のクエリを、必要な範囲だけ解釈する */
  function applyFilters(rows, params) {
    let out = rows;
    for (const [key, raw] of params) {
      if (['select', 'order', 'limit', 'on_conflict', 'offset'].includes(key)) continue;
      const m = String(raw).match(/^(eq|neq|in|ilike|gte|lte)\.(.*)$/s);
      if (!m) continue;
      const [, op, val] = m;
      out = out.filter(r => {
        const cur = r[key];
        if (op === 'eq') return String(cur) === val;
        if (op === 'neq') return String(cur) !== val;
        if (op === 'in') {
          const set = val.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, ''));
          return set.includes(String(cur));
        }
        if (op === 'ilike') return String(cur).toLowerCase().includes(val.replace(/%/g, '').toLowerCase());
        if (op === 'gte') return cur >= val;
        if (op === 'lte') return cur <= val;
        return true;
      });
    }
    const order = params.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      out = out.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    const limit = params.get('limit');
    if (limit) out = out.slice(0, +limit);
    return out;
  }

  const pick = (rows, select) => {
    if (!select || select === '*') return rows;
    const cols = select.split(',').map(s => s.trim());
    return rows.map(r => { const o = {}; for (const c of cols) o[c] = r[c]; return o; });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Expose-Headers': '*',
      });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204);

    // 本文はまずバイト列として受ける。文字列で受けると画像が壊れる。
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBuf = Buffer.concat(chunks);
    const raw = rawBuf.toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }

    const me = findUserByToken(req);
    const p = url.pathname;

    /* ---------------- 認証 ---------------- */
    if (p === '/auth/v1/signup' || p.startsWith('/auth/v1/token')) {
      const { email, password } = body || {};
      if (!email || !password) return send(400, { msg: 'missing' });
      if (password.length < 6) return send(400, { msg: 'Password should be at least 6 characters' });

      let user = db.users.find(u => u.email === email);
      if (p === '/auth/v1/signup') {
        if (user) return send(400, { msg: 'User already registered' });
        user = { id: randomUUID(), email, password };
        db.users.push(user);
        // schema.sql のトリガと同じく、プロフィールの器を作る
        db.profiles.push({
          id: user.id,
          nickname: 'user' + user.id.replace(/-/g, '').slice(0, 8),
          icon_emoji: '🐾', icon_color: '#1b6b4a', avatar_path: null,
        });
      } else {
        if (!user || user.password !== password) return send(400, { msg: 'Invalid login credentials' });
      }
      const token = 'tok_' + randomUUID();
      tokens.set(token, user.id);
      return send(200, {
        access_token: token, refresh_token: 'ref_' + token, expires_in: 3600,
        user: { id: user.id, email: user.email },
      });
    }
    if (p === '/auth/v1/logout') { return send(204); }

    /* ---------------- RPC ---------------- */
    if (p === '/rest/v1/rpc/search_profiles') {
      const q = String((body && body.q) || '').toLowerCase();
      const hit = db.profiles.filter(x => x.nickname.toLowerCase().includes(q)).slice(0, 20);
      // schema.sql の search_profiles と同じ列を返すこと。
      // ここがずれると、テストが通っても本番で欠ける。
      return send(200, hit.map(x => ({
        id: x.id, nickname: x.nickname, icon_emoji: x.icon_emoji,
        icon_color: x.icon_color, avatar_path: x.avatar_path || null,
      })));
    }

    /* ---------------- テーブル ---------------- */
    const t = p.match(/^\/rest\/v1\/(\w+)$/);
    if (t) {
      const table = t[1];
      if (!db[table]) return send(404, { message: 'no such table' });
      const params = url.searchParams;

      if (req.method === 'GET') {
        let rows = db[table];
        if (table === 'visits') rows = rows.filter(v => canSeeVisit(me, v));   // ← RLS 相当
        if (table === 'blocks') rows = rows.filter(x => x.blocker === me);
        if (table === 'reports') rows = rows.filter(x => x.reporter === me);
        if (table === 'photos') rows = rows.filter(ph => {
          const v = db.visits.find(x => x.id === ph.visit_id);
          return v && canSeeVisit(me, v);
        });
        return send(200, pick(applyFilters(rows, params), params.get('select')));
      }

      if (req.method === 'POST') {
        if (!me) return send(401, { message: 'not authenticated' });
        const rows = Array.isArray(body) ? body : [body];
        const prefer = String(req.headers['prefer'] || '');
        const upsert = prefer.includes('merge-duplicates');
        const out = [];
        for (const r of rows) {
          const row = Object.assign({}, r);
          if ('user_id' in row && row.user_id !== me) return send(403, { message: 'row violates row-level security policy' });
          if (table === 'blocks') {
            if (row.blocker !== me) return send(403, { message: 'row violates row-level security policy' });
            if (row.blocker === row.blocked) return send(400, { message: 'no_self_block' });
            const dup = db.blocks.find(x => x.blocker === row.blocker && x.blocked === row.blocked);
            if (dup) { out.push(dup); continue; }
            db.blocks.push(row); out.push(row); continue;
          }
          if (table === 'reports') {
            if (row.reporter !== me) return send(403, { message: 'row violates row-level security policy' });
            if (!['spam','offensive','private','other'].includes(row.reason)) {
              return send(400, { message: 'reports_reason_check' });
            }
            row.id = randomUUID(); row.status = 'open';
            db.reports.push(row); out.push(row); continue;
          }
          if (table === 'follows') {
            if (row.follower !== me) return send(403, { message: 'row violates row-level security policy' });
            if (row.follower === row.followee) return send(400, { message: 'no_self_follow' });
            const dup = db.follows.find(f => f.follower === row.follower && f.followee === row.followee);
            if (dup) { out.push(dup); continue; }
            db.follows.push(row); out.push(row); continue;
          }
          if (table === 'visits') {
            if (!['friends', 'public'].includes(row.visibility)) {
              return send(400, { message: 'visits_visibility_check' });   // private は受け付けない
            }
            const dup = row.local_id && db.visits.find(v => v.user_id === me && v.local_id === row.local_id);
            if (dup && upsert) {
              const keep = dup.created_at;          // 上書きでも投稿時刻は変えない
              Object.assign(dup, row); dup.created_at = keep;
              out.push(dup); continue;
            }
            if (dup) return send(409, { message: 'duplicate key value violates unique constraint' });
            row.id = row.id || randomUUID();
            row.created_at = new Date().toISOString();
            db.visits.push(row); out.push(row); continue;
          }
          row.id = row.id || randomUUID();
          db[table].push(row); out.push(row);
        }
        return send(201, out);
      }

      if (req.method === 'PATCH') {
        if (!me) return send(401, { message: 'not authenticated' });
        const target = applyFilters(db[table], params);
        for (const r of target) {
          const owner = r.user_id || r.id;
          if (owner !== me) return send(403, { message: 'row violates row-level security policy' });
          if (table === 'profiles' && body.nickname) {
            const clash = db.profiles.find(x => x.id !== r.id &&
              x.nickname.toLowerCase() === String(body.nickname).toLowerCase());
            if (clash) return send(409, { message: 'duplicate key value violates unique constraint "profiles_nickname_key"' });
          }
          Object.assign(r, body);
        }
        return send(200, target);
      }

      if (req.method === 'DELETE') {
        if (!me) return send(401, { message: 'not authenticated' });
        const target = applyFilters(db[table], params);
        for (const r of target) {
          const owner = r.user_id || r.follower || r.blocker || r.id;
          if (owner !== me) return send(403, { message: 'row violates row-level security policy' });
          const i = db[table].indexOf(r);
          if (i >= 0) db[table].splice(i, 1);
          if (table === 'visits') db.photos = db.photos.filter(ph => ph.visit_id !== r.id);
        }
        return send(204);
      }
    }

    /* ---------------- 写真の置き場 ---------------- */
    // 公開バケットは認証なしで読める
    const pub = p.match(/^\/storage\/v1\/object\/public\/([\w-]+)\/(.+)$/);
    if (pub && req.method === 'GET') {
      const key = pub[1] + '/' + decodeURIComponent(pub[2]);
      if (!db.objects.has(key)) return send(404, { message: 'not found' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' });
      return res.end(db.objects.get(key));
    }

    const o = p.match(/^\/storage\/v1\/object\/([\w-]+)\/(.+)$/);
    if (o) {
      const bucket = o[1];
      const key = bucket + '/' + decodeURIComponent(o[2]);
      const folder = decodeURIComponent(o[2]).split('/')[0];
      if (req.method === 'POST') {
        if (!me) return send(401, { message: 'not authenticated' });
        if (folder !== me) return send(403, { message: 'new row violates row-level security policy' });
        db.objects.set(key, rawBuf);
        return send(200, { Key: key });
      }
      if (req.method === 'GET') {
        if (!db.objects.has(key)) return send(404, { message: 'not found' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' });
        return res.end(db.objects.get(key));
      }
      if (req.method === 'DELETE') {
        if (!me) return send(401, { message: 'not authenticated' });
        if (folder !== me) return send(403, { message: 'row violates row-level security policy' });
        db.objects.delete(key); return send(200, {});
      }
    }

    send(404, { message: 'not found: ' + p });
  });

  return { server, db, tokens };
}

if (require.main === module) {
  const port = +(process.argv[2] || 8100);
  const { server } = createMock();
  server.listen(port, () => console.log('mock supabase on http://localhost:' + port));
}

module.exports = { createMock };
