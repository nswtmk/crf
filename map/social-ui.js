'use strict';

/* =========================================================================
   social-ui.js — アカウント・プロフィール・友達の画面
   地図と記録そのものは app.js が持つ。ここはその周りだけを受け持つ。
   ========================================================================= */

(function (global) {

  const $ = s => document.querySelector(s);
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

  const EMOJI = ['🐾','🚶','🏔️','🌊','🍜','☕','📷','🚲','🚆','✈️','🌸','🍁','⛩️','🏕️','🌙','⭐',
                 '🐱','🐶','🦊','🐧','🦉','🐢','🌵','🌻','🍺','🎣','🎿','🏄','🧭','🗺️','🔦','🎒'];
  const COLORS = ['#1b6b4a','#2a7fd4','#8b5cf6','#d4487f','#d97706','#0f766e','#475569','#b91c1c'];

  const UI = {
    supa: null, social: null, onChanged: null,
    pendingEmoji: '🐾', pendingColor: '#1b6b4a',
    tab: 'friends',
  };

  /* ---------- アイコンの描画 ----------
     写真があれば写真、無ければ絵文字と背景色。表示する場所が複数あるので
     一か所にまとめる。
     ------------------------------------------------------------------ */

  function paintAvatar(node, profile) {
    node.textContent = '';
    node.style.background = '';
    node.classList.remove('hasphoto');
    if (!profile) { node.textContent = '👤'; node.style.background = '#888'; return node; }
    const url = UI.social ? UI.social.avatarUrl(profile) : null;
    if (url) {
      const img = el('img');
      img.src = url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      // 読めなかったら絵文字に戻す (消された・圏外など)
      img.addEventListener('error', () => {
        node.textContent = profile.icon_emoji || '🐾';
        node.style.background = profile.icon_color || '#888';
        node.classList.remove('hasphoto');
      });
      node.append(img);
      node.classList.add('hasphoto');
    } else {
      node.textContent = profile.icon_emoji || '🐾';
      node.style.background = profile.icon_color || '#888';
    }
    return node;
  }

  /** 画像を正方形に切り抜いて小さくする。中央を残す。 */
  function squareThumb(file, size) {
    size = size || 256;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
        URL.revokeObjectURL(url);
        c.toBlob(b => b ? resolve(b) : reject(new Error('画像を変換できませんでした')), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読めませんでした')); };
      img.src = url;
    });
  }

  /* ---------- 画面の状態を合わせる ---------- */

  function refreshAvatar() {
    const btn = $('#me'), icon = $('#me-icon'), name = $('#me-name');
    if (!UI.supa || !UI.supa.configured || !UI.supa.signedIn) {
      icon.textContent = '👤'; icon.style.background = ''; icon.classList.remove('hasphoto');
      name.textContent = 'ログイン';
      btn.style.background = ''; btn.classList.remove('on');
      return;
    }
    const me = UI.social.me;
    name.textContent = me ? me.nickname : '...';
    paintAvatar(icon, me);
    btn.style.background = me ? (me.avatar_path ? 'var(--brand)' : me.icon_color) : '';
    btn.classList.add('on');
  }

  function showAccountSection() {
    const configured = UI.supa && UI.supa.configured;
    const signedIn = configured && UI.supa.signedIn;
    $('#a-setup').classList.toggle('hidden', configured);
    $('#a-auth').classList.toggle('hidden', !configured || signedIn);
    $('#a-me').classList.toggle('hidden', !signedIn);
    if (signedIn) fillProfileForm();
  }

  function fillProfileForm() {
    const me = UI.social.me;
    $('#p-name').textContent = me ? me.nickname : '(読み込み中)';
    $('#p-mail').textContent = UI.supa.session ? UI.supa.session.email || '' : '';
    $('#p-nick').value = me ? me.nickname : '';
    UI.pendingEmoji = me ? me.icon_emoji : '🐾';
    UI.pendingColor = me ? me.icon_color : '#1b6b4a';
    renderPickers();
    updatePreview();
  }

  function updatePreview() {
    const me = UI.social.me;
    const p = $('#p-preview');
    if (me && me.avatar_path) {
      paintAvatar(p, me);
    } else {
      p.textContent = UI.pendingEmoji;
      p.style.background = UI.pendingColor;
      p.classList.remove('hasphoto');
    }
    $('#p-clear-avatar').classList.toggle('hidden', !(me && me.avatar_path));
    // ラベルだけを書き換える。<label> ごと textContent で潰すと、
    // 中にあるファイル入力まで消えて写真を選べなくなる。
    $('#p-pick-label').textContent = (me && me.avatar_path) ? '写真を変える' : '写真を選ぶ';
    if (me && me.avatar_path) $('#emoji-details').open = false;
  }

  function renderPickers() {
    const eg = $('#p-emoji'); eg.textContent = '';
    for (const e of EMOJI) {
      const b = el('button', 'emojibtn' + (e === UI.pendingEmoji ? ' on' : ''));
      b.textContent = e; b.type = 'button';
      b.addEventListener('click', () => { UI.pendingEmoji = e; renderPickers(); updatePreview(); });
      eg.append(b);
    }
    const cg = $('#p-color'); cg.textContent = '';
    for (const c of COLORS) {
      const b = el('button', 'colorbtn' + (c === UI.pendingColor ? ' on' : ''));
      b.type = 'button'; b.style.background = c; b.title = c;
      b.addEventListener('click', () => { UI.pendingColor = c; renderPickers(); updatePreview(); });
      cg.append(b);
    }
  }

  function msg(sel, text, bad) {
    const n = $(sel);
    n.textContent = text || '';
    n.classList.toggle('err', !!bad);
  }

  /* ---------- 人の行 ---------- */

  function personRow(p) {
    const row = el('div', 'person');
    const ic = paintAvatar(el('span', 'peicon'), p);

    const body = el('div', 'pebody');
    const nm = el('div', 'pename'); nm.textContent = p.nickname;
    const rel = el('div', 'perel');
    rel.textContent = p.blocked ? 'ブロック中 — 記録はおたがいに見えません'
      : p.friend ? '友達 (おたがいにフォロー)'
      : p.following ? 'フォロー中'
      : p.followsMe ? 'あなたをフォローしています' : '';
    body.append(nm, rel);

    const btn = el('button', 'febtn' + (p.blocked ? ' blocked' : p.following ? ' on' : ''));
    btn.textContent = p.blocked ? 'ブロック解除' : p.following ? 'フォロー中' : 'フォローする';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (p.blocked) await UI.social.unblock(p.id);
        else if (p.following) await UI.social.unfollow(p.id);
        else await UI.social.follow(p.id);
        await UI.social.loadFollows();
        await UI.social.loadBlocks();
        await renderFriendList();
        await runSearch();
        if (UI.onChanged) UI.onChanged();
      } catch (e) {
        alert(e.message);
      }
      btn.disabled = false;
    });

    row.append(ic, body, btn);
    return row;
  }

  /* ---------- 友達の画面 ---------- */

  let searchTimer = null;
  async function runSearch() {
    const q = $('#fr-q').value.trim();
    const box = $('#fr-results');
    if (!q) { box.textContent = ''; return; }
    try {
      const found = await UI.social.searchPeople(q);
      const list = await UI.social.decorate(found);
      box.textContent = '';
      if (!list.length) {
        const p = el('p', 'hint'); p.textContent = '見つかりませんでした。';
        box.append(p); return;
      }
      for (const p of list) box.append(personRow(p));
    } catch (e) {
      box.textContent = '';
      const p = el('p', 'hint err'); p.textContent = '検索できませんでした: ' + e.message;
      box.append(p);
    }
  }

  async function renderFriendList() {
    const box = $('#fr-list');
    box.textContent = '';
    const s = UI.social;
    const ids = UI.tab === 'friends' ? s.friends
              : UI.tab === 'following' ? [...s.following]
              : UI.tab === 'blocked' ? [...s.blocked]
              : [...s.followers];
    if (!ids.length) {
      const p = el('p', 'hint');
      p.textContent = UI.tab === 'friends'
        ? 'まだ友達がいません。相手を探してフォローし、相手からもフォローされると友達になります。'
        : UI.tab === 'following' ? 'まだ誰もフォローしていません。'
        : UI.tab === 'blocked' ? 'ブロックしている人はいません。' : 'まだフォロワーがいません。';
      box.append(p); return;
    }
    try {
      const list = await s.decorate(await s.getProfiles(ids));
      for (const p of list) box.append(personRow(p));
    } catch (e) {
      const p = el('p', 'hint err'); p.textContent = '読み込めませんでした: ' + e.message;
      box.append(p);
    }
  }

  /* ---------- 開く ---------- */

  async function openAccount() {
    showAccountSection();
    $('#account-bg').classList.remove('hidden');
    if (UI.supa && UI.supa.signedIn && !UI.social.me) {
      try { await UI.social.loadMe(); fillProfileForm(); refreshAvatar(); } catch (e) {}
    }
  }

  async function openFriends() {
    if (!UI.supa || !UI.supa.signedIn) { openAccount(); return; }
    $('#fr-q').value = '';
    $('#fr-results').textContent = '';
    $('#friends-bg').classList.remove('hidden');
    try { await UI.social.loadFollows(); await UI.social.loadBlocks(); } catch (e) {}
    await renderFriendList();
  }

  /* ---------- 通報とブロック ---------- */

  let reporting = null, reportReason = 'offensive';

  function openReport(visit) {
    if (!UI.supa || !UI.supa.signedIn) { alert('通報するにはログインが必要です。'); return; }
    reporting = visit;
    reportReason = 'offensive';
    const box = $('#rp-reasons');
    box.textContent = '';
    for (const r of global.ReportReasons) {
      const b = el('button', 'reasonbtn' + (r.key === reportReason ? ' on' : ''));
      b.type = 'button'; b.textContent = r.label;
      b.addEventListener('click', () => {
        reportReason = r.key;
        for (const o of box.children) o.classList.toggle('on', o === b);
      });
      box.append(b);
    }
    $('#rp-note').value = '';
    msg('#rp-msg', '');
    $('#report-bg').classList.remove('hidden');
  }

  async function sendReport() {
    if (!reporting) return;
    msg('#rp-msg', '送っています…');
    try {
      await UI.social.report(reporting, reportReason, $('#rp-note').value);
      $('#report-bg').classList.add('hidden');
      $('#other-bg').classList.add('hidden');
      alert('通報を受け付けました。内容を確認し、問題があれば削除します。');
      reporting = null;
    } catch (e) {
      msg('#rp-msg', e.message, true);
    }
  }

  async function blockAuthor(visit) {
    if (!UI.supa || !UI.supa.signedIn) return;
    if (!confirm('この人をブロックします。\nおたがいの記録が見えなくなり、フォローも外れます。')) return;
    try {
      await UI.social.block(visit.userId);
      await UI.social.loadFollows();
      $('#other-bg').classList.add('hidden');
      if (UI.onChanged) UI.onChanged();
      alert('ブロックしました。友達の画面から解除できます。');
    } catch (e) { alert(e.message); }
  }

  /* ---------- 起動 ---------- */

  function init(opts) {
    UI.supa = opts.supa;
    UI.social = opts.social;
    UI.onChanged = opts.onChanged;

    $('#me').addEventListener('click', () => {
      if (UI.supa && UI.supa.signedIn) openFriends(); else openAccount();
    });
    $('#me').addEventListener('contextmenu', e => { e.preventDefault(); openAccount(); });

    $('#account-close').addEventListener('click', () => $('#account-bg').classList.add('hidden'));
    $('#fr-account').addEventListener('click', () => {
      $('#friends-bg').classList.add('hidden');
      openAccount();
    });
    $('#friends-close').addEventListener('click', () => $('#friends-bg').classList.add('hidden'));

    // 接続先の設定
    $('#a-save-conf').addEventListener('click', () => {
      const url = $('#a-url').value.trim().replace(/\/+$/, '');
      const key = $('#a-key').value.trim();
      if (!/^https:\/\/[\w-]+\.supabase\.co$/.test(url)) {
        alert('プロジェクトURLの形が違います。https://xxxx.supabase.co の形です。'); return;
      }
      if (key.length < 20) { alert('anon キーが短すぎます。貼り間違いを確認してください。'); return; }
      global.SupaConfig.save(url, key);
      UI.supa.url = url; UI.supa.anonKey = key;
      showAccountSection();
      refreshAvatar();
    });

    $('#a-forget').addEventListener('click', () => {
      if (!confirm('接続先の設定を消します。記録そのものは端末に残ります。')) return;
      global.SupaConfig.clear();
      UI.supa.url = ''; UI.supa.anonKey = '';
      UI.supa.session = null; UI.supa._save();
      showAccountSection(); refreshAvatar();
      if (UI.onChanged) UI.onChanged();
    });

    const doAuth = async (kind) => {
      const email = $('#a-email').value.trim();
      const pass = $('#a-pass').value;
      if (!email || !pass) { msg('#a-msg', 'メールアドレスとパスワードを入れてください。', true); return; }
      msg('#a-msg', kind === 'up' ? '登録しています…' : 'ログインしています…');
      try {
        const r = kind === 'up' ? await UI.supa.signUp(email, pass) : await UI.supa.signIn(email, pass);
        if (r.needsEmail) {
          msg('#a-msg', '確認メールを送りました。メール内のリンクを開いてから、ログインしてください。');
          return;
        }
        await UI.social.loadMe();
        await UI.social.loadFollows();
        $('#a-pass').value = '';
        msg('#a-msg', '');
        showAccountSection(); refreshAvatar();
        if (UI.onChanged) UI.onChanged();
      } catch (e) {
        msg('#a-msg', e.message, true);
      }
    };
    $('#a-signin').addEventListener('click', () => doAuth('in'));
    $('#a-signup').addEventListener('click', () => doAuth('up'));

    $('#a-signout').addEventListener('click', async () => {
      if (!confirm('ログアウトします。端末の記録はそのまま残ります。')) return;
      await UI.supa.signOut();
      UI.social.me = null;
      UI.social.following = new Set();
      UI.social.followers = new Set();
      showAccountSection(); refreshAvatar();
      if (UI.onChanged) UI.onChanged();
    });

    $('#p-file').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!f.type.startsWith('image/')) { msg('#p-msg', '画像を選んでください。', true); return; }
      msg('#p-msg', '写真を整えています…');
      try {
        const blob = await squareThumb(f, 256);
        msg('#p-msg', '送っています…');
        await UI.social.setAvatar(blob);
        msg('#p-msg', 'アイコンを変えました。');
        updatePreview(); refreshAvatar();
        if (UI.onChanged) UI.onChanged();
      } catch (err) { msg('#p-msg', err.message, true); }
    });

    $('#p-clear-avatar').addEventListener('click', async () => {
      if (!confirm('写真のアイコンをやめて、絵文字に戻します。')) return;
      msg('#p-msg', '戻しています…');
      try {
        await UI.social.clearAvatar();
        msg('#p-msg', '絵文字に戻しました。');
        updatePreview(); refreshAvatar();
        if (UI.onChanged) UI.onChanged();
      } catch (err) { msg('#p-msg', err.message, true); }
    });

    $('#p-save').addEventListener('click', async () => {
      msg('#p-msg', '保存しています…');
      try {
        await UI.social.saveProfile($('#p-nick').value, UI.pendingEmoji, UI.pendingColor);
        msg('#p-msg', '保存しました。');
        fillProfileForm(); refreshAvatar();
      } catch (e) { msg('#p-msg', e.message, true); }
    });

    $('#fr-q').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 300);
    });
    for (const t of document.querySelectorAll('.tabrow .tab')) {
      t.addEventListener('click', () => {
        UI.tab = t.dataset.tab;
        for (const o of document.querySelectorAll('.tabrow .tab')) o.classList.toggle('on', o === t);
        renderFriendList();
      });
    }

    for (const id of ['account-bg', 'friends-bg', 'other-bg']) {
      $('#' + id).addEventListener('click', e => {
        if (e.target.id === id) $('#' + id).classList.add('hidden');
      });
    }
    $('#o-close').addEventListener('click', () => $('#other-bg').classList.add('hidden'));
    $('#o-report').addEventListener('click', () => { if (UI.currentOther) openReport(UI.currentOther); });
    $('#o-block').addEventListener('click', () => { if (UI.currentOther) blockAuthor(UI.currentOther); });
    $('#rp-cancel').addEventListener('click', () => $('#report-bg').classList.add('hidden'));
    $('#rp-send').addEventListener('click', sendReport);
    $('#report-bg').addEventListener('click', e => {
      if (e.target.id === 'report-bg') $('#report-bg').classList.add('hidden');
    });

    // 連絡先。ガイドライン 1.2 は問い合わせ先を出すことを求めている。
    const mail = (global.TRAILMAP_CONTACT || 'nswtmk@gmail.com');
    const a = $('#contact-mail');
    a.textContent = mail;
    a.href = 'mailto:' + mail + '?subject=' + encodeURIComponent('足あと地図について');

    refreshAvatar();
    showAccountSection();
  }

  global.SocialUI = {
    init, refreshAvatar, openAccount, openFriends, showAccountSection,
    openReport, blockAuthor, EMOJI, COLORS, paintAvatar, squareThumb,
    setCurrentOther: v => { UI.currentOther = v; },
  };

})(typeof window !== 'undefined' ? window : globalThis);
