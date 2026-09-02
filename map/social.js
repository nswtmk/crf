'use strict';

/* =========================================================================
   social.js — プロフィール・フォロー・同期
   端末の記録が正本。「友達」「全体」を選んだものだけがサーバーへ上がる。
   「自分だけ」は一度もサーバーに触れない。
   ========================================================================= */

(function (global) {

  const VIS = {
    private: { key: 'private', label: '自分だけ', icon: '🔒', remote: false },
    friends: { key: 'friends', label: '友達だけ', icon: '👥', remote: true },
    public:  { key: 'public',  label: '全体に公開', icon: '🌏', remote: true },
  };
  const VIS_ORDER = ['private', 'friends', 'public'];
  const DEFAULT_VIS = 'private';           // 既定は外に出さない

  function visOf(v) { return VIS[v] || VIS[DEFAULT_VIS]; }
  function shouldUpload(v) { return visOf(v).remote; }

  class Social {
    constructor(supa) {
      this.supa = supa;
      this.me = null;                      // 自分のプロフィール
      this.following = new Set();          // 自分がフォローしている人
      this.followers = new Set();          // 自分をフォローしている人
      this.blocked = new Set();            // 自分がブロックした人
    }

    get signedIn() { return this.supa && this.supa.signedIn; }
    get friends() { return [...this.following].filter(id => this.followers.has(id)); }
    isFriend(id) { return this.following.has(id) && this.followers.has(id); }

    /* ---------- プロフィール ---------- */

    async loadMe() {
      if (!this.signedIn) { this.me = null; return null; }
      const rows = await this.supa.select('profiles',
        'id=eq.' + this.supa.userId + '&select=id,nickname,icon_emoji,icon_color');
      this.me = (rows && rows[0]) || null;
      return this.me;
    }

    async saveProfile(nickname, emoji, color) {
      const name = String(nickname || '').trim();
      const bad = validateNickname(name);
      if (bad) throw new Error(bad);
      try {
        const rows = await this.supa.update('profiles', 'id=eq.' + this.supa.userId,
          { nickname: name, icon_emoji: emoji || '🐾', icon_color: color || '#1b6b4a' });
        this.me = (rows && rows[0]) || this.me;
        return this.me;
      } catch (e) {
        // 一意制約に当たったときは何が起きたか分かる文言にする
        if (/duplicate|unique|already exists/i.test(e.message)) {
          throw new Error('そのニックネームは使われています。別の名前にしてください。');
        }
        throw e;
      }
    }

    async getProfile(id) {
      const rows = await this.supa.select('profiles',
        'id=eq.' + id + '&select=id,nickname,icon_emoji,icon_color');
      return (rows && rows[0]) || null;
    }

    async searchPeople(q) {
      const term = String(q || '').trim();
      if (term.length < 1) return [];
      const rows = await this.supa.rpc('search_profiles', { q: term });
      return (rows || []).filter(p => p.id !== this.supa.userId);
    }

    /* ---------- フォロー ---------- */

    async loadFollows() {
      if (!this.signedIn) { this.following = new Set(); this.followers = new Set(); return; }
      const me = this.supa.userId;
      const [out, inc] = await Promise.all([
        this.supa.select('follows', 'follower=eq.' + me + '&select=followee'),
        this.supa.select('follows', 'followee=eq.' + me + '&select=follower'),
      ]);
      this.following = new Set((out || []).map(r => r.followee));
      this.followers = new Set((inc || []).map(r => r.follower));
    }

    async follow(id) {
      if (id === this.supa.userId) throw new Error('自分はフォローできません');
      await this.supa.insert('follows', { follower: this.supa.userId, followee: id },
        { upsert: true, onConflict: 'follower,followee' });
      this.following.add(id);
    }

    async unfollow(id) {
      await this.supa.remove('follows',
        'follower=eq.' + this.supa.userId + '&followee=eq.' + id);
      this.following.delete(id);
    }

    /** 相手それぞれについて、フォロワー数と自分との関係をまとめる */
    async decorate(people) {
      return people.map(p => Object.assign({}, p, {
        following: this.following.has(p.id),
        followsMe: this.followers.has(p.id),
        friend: this.isFriend(p.id),
        blocked: this.blocked.has(p.id),
      }));
    }

    /* ---------- ブロックと通報 ----------
       App Store のガイドライン 1.2 が求める、通報とブロックの受け口。
       ------------------------------------------------------------------ */

    async loadBlocks() {
      if (!this.signedIn) { this.blocked = new Set(); return; }
      const rows = await this.supa.select('blocks',
        'blocker=eq.' + this.supa.userId + '&select=blocked');
      this.blocked = new Set((rows || []).map(r => r.blocked));
    }

    async block(id) {
      if (id === this.supa.userId) throw new Error('自分はブロックできません');
      await this.supa.insert('blocks', { blocker: this.supa.userId, blocked: id },
        { upsert: true, onConflict: 'blocker,blocked' });
      this.blocked.add(id);
      // ブロックした相手とのフォロー関係は切っておく
      await this.unfollow(id).catch(() => {});
    }

    async unblock(id) {
      await this.supa.remove('blocks',
        'blocker=eq.' + this.supa.userId + '&blocked=eq.' + id);
      this.blocked.delete(id);
    }

    isBlocked(id) { return this.blocked.has(id); }

    /** 通報を出す。reason は spam / offensive / private / other。 */
    async report(visit, reason, note) {
      if (!this.signedIn) throw new Error('通報するにはログインが必要です');
      await this.supa.insert('reports', {
        reporter: this.supa.userId,
        visit_id: visit.id,
        target: visit.userId,
        reason: reason,
        note: String(note || '').slice(0, 1000),
      });
    }

    /* ---------- 同期 ----------
       端末の記録が正本。上げるのは公開範囲が private でないものだけ。
       ------------------------------------------------------------------ */

    /** 1件を反映する。private なら、既に上がっている分を消す。 */
    async pushVisit(v) {
      if (!this.signedIn) return null;
      const me = this.supa.userId;

      if (!shouldUpload(v.visibility)) {
        if (v.remoteId) {
          await this.deleteRemote(v).catch(() => {});
          return { removed: true };
        }
        return null;
      }

      const row = {
        user_id: me,
        local_id: v.id,
        lat: v.lat, lng: v.lng,
        visited_at: new Date(v.ts).toISOString(),
        title: v.title || '',
        comment: v.comment || '',
        visibility: v.visibility,
      };
      const rows = await this.supa.insert('visits', row,
        { upsert: true, onConflict: 'user_id,local_id' });
      const saved = rows && rows[0];
      return saved ? { remoteId: saved.id } : null;
    }

    async deleteRemote(v) {
      if (!this.signedIn || !v.remoteId) return;
      await this.supa.remove('photos', 'visit_id=eq.' + v.remoteId).catch(() => {});
      await this.supa.remove('visits', 'id=eq.' + v.remoteId + '&user_id=eq.' + this.supa.userId);
    }

    /** 自分の記録をまとめて反映する。結果は {id: remoteId} の対応表。 */
    async pushAll(visits, onProgress) {
      const map = {};
      let done = 0;
      for (const v of visits) {
        try {
          const r = await this.pushVisit(v);
          if (r && r.remoteId) map[v.id] = r.remoteId;
          if (r && r.removed) map[v.id] = null;
        } catch (e) {
          // 1件失敗しても残りは続ける
          if (onProgress) onProgress(++done, visits.length, e);
          continue;
        }
        if (onProgress) onProgress(++done, visits.length, null);
      }
      return map;
    }

    /**
     * 他の人の記録を取ってくる。何が見えるかはサーバー側の RLS が決めるので、
     * ここでは絞り込みを書かない (書いても意味がなく、書き忘れが事故になる)。
     */
    async fetchOthers(limit) {
      if (!this.signedIn) return [];
      // ブロックした相手はサーバー側でも除かれるが、手元でも念のため落とす。
      // 片方だけに頼ると、どちらかの取りこぼしがそのまま事故になる。
      const rows = await this.supa.select('visits',
        'user_id=neq.' + this.supa.userId +
        '&select=id,user_id,lat,lng,visited_at,title,comment,visibility' +
        '&order=visited_at.desc&limit=' + (limit || 300));
      if (!rows || !rows.length) return [];

      const ids = [...new Set(rows.map(r => r.user_id))];
      const profs = await this.supa.select('profiles',
        'id=in.(' + ids.join(',') + ')&select=id,nickname,icon_emoji,icon_color');
      const byId = {};
      for (const p of (profs || [])) byId[p.id] = p;

      return rows.filter(r => !this.blocked.has(r.user_id)).map(r => ({
        id: r.id,
        userId: r.user_id,
        lat: r.lat, lng: r.lng,
        ts: new Date(r.visited_at).getTime(),
        title: r.title, comment: r.comment,
        visibility: r.visibility,
        author: byId[r.user_id] || { nickname: '(不明)', icon_emoji: '👤', icon_color: '#888888' },
      }));
    }
  }

  function validateNickname(name) {
    if (!name) return 'ニックネームを入れてください。';
    if (name.length > 20) return 'ニックネームは20文字までです。';
    if (/[\s]/.test(name) && name.trim() !== name) return '前後の空白は使えません。';
    if (/[<>"'&\\/]/.test(name)) return '記号 < > " \' & \\ / は使えません。';
    return null;
  }

  const REPORT_REASONS = [
    { key: 'offensive', label: '不快・攻撃的な内容' },
    { key: 'private',   label: '個人情報が含まれている' },
    { key: 'spam',      label: '宣伝・迷惑行為' },
    { key: 'other',     label: 'その他' },
  ];

  global.Social = Social;
  global.ReportReasons = REPORT_REASONS;
  global.Visibility = { VIS, VIS_ORDER, DEFAULT_VIS, visOf, shouldUpload, validateNickname };

})(typeof window !== 'undefined' ? window : globalThis);
