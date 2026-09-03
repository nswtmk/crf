/* =========================================================================
   test-social.js — 公開範囲とフォローの検証 (ブラウザ不要)
   mock-supabase.js を立て、supa.js / social.js を実際に通信させて確かめる。
   実行: node test-social.js
   ========================================================================= */
'use strict';
const { createMock } = require('./mock-supabase.js');

// ブラウザの部品を最小限だけ用意する
const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
globalThis.window = globalThis;
require('./supa.js');
require('./social.js');

// social-ui.js は画面部品を触るので、最低限の受け皿を用意して読み込む
const _stub = { addEventListener() {}, append() {}, querySelectorAll: () => [],
                classList: { toggle() {}, add() {}, remove() {} }, style: {}, dataset: {} };
globalThis.document = {
  addEventListener() {}, querySelector: () => _stub, querySelectorAll: () => [],
  createElement: () => Object.create(_stub),
};
// Node 22 の navigator は書き換えられないが、social-ui.js は使わないので触らない
globalThis.alert = () => {};
globalThis.confirm = () => true;
require('./social-ui.js');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (e ? '  ' + e : '')); };
const head = t => console.log('\n=== ' + t + ' ===');

/** 利用者ごとに独立したセッションを持たせる (localStorage を分ける) */
function newClient(url) {
  const own = {};
  const s = new globalThis.Supa(url, 'anon-test-key');
  s._load = () => {};
  s._save = () => { own.session = s.session; };
  return { supa: s, social: new globalThis.Social(s) };
}

/** schema.sql の search_profiles が返す列と、モックが返す列を突き合わせる */
function schemaSearchColumns() {
  const sql = require('fs').readFileSync(__dirname + '/schema.sql', 'utf8');
  const m = sql.match(/function public\.search_profiles[\s\S]*?returns table \(([^)]*)\)/);
  return m ? m[1].split(',').map(s => s.trim().split(/\s+/)[0]).sort() : [];
}

(async () => {
  const { server, db } = createMock();
  await new Promise(r => server.listen(0, r));
  const url = 'http://localhost:' + server.address().port;

  const A = newClient(url);   // あなた
  const B = newClient(url);   // 友達になる人
  const C = newClient(url);   // 他人

  head('プロジェクトURLの読み取り');
  {
    // 管理画面のアドレスを貼る人が多いので、直せるものは直す
    const N = globalThis.SocialUI.normalizeProjectUrl;
    const want = 'https://abcdefghijklmnop.supabase.co';
    const good = [
      ['そのままの形', want],
      ['末尾スラッシュ', want + '/'],
      ['前後の空白', '  ' + want + '  '],
      ['末尾にパス', want + '/rest/v1'],
      ['https 抜け', 'abcdefghijklmnop.supabase.co'],
      ['管理画面のアドレス', 'https://supabase.com/dashboard/project/abcdefghijklmnop'],
      ['管理画面の設定ページ', 'https://supabase.com/dashboard/project/abcdefghijklmnop/settings/api'],
    ];
    for (const [label, input] of good) {
      const r = N(input);
      ok(label + ' を正しく読む', r.url === want, r.url || r.error);
    }
    const bad = [
      ['空', ''],
      ['日本語', 'これはURLではない'],
      ['プロジェクトでない管理画面', 'https://supabase.com/dashboard'],
      ['キーを貼ってしまった', 'sb_publishable_abcdefghijklmnop'],
    ];
    for (const [label, input] of bad) {
      const r = N(input);
      ok(label + ' は断る', !!r.error, r.url || r.error);
    }
  }

  head('サインアップとプロフィール');
  await A.supa.signUp('a@example.com', 'password1');
  await B.supa.signUp('b@example.com', 'password1');
  await C.supa.signUp('c@example.com', 'password1');
  ok('3人が登録できた', A.supa.signedIn && B.supa.signedIn && C.supa.signedIn);

  await A.social.loadMe();
  ok('登録と同時にプロフィールの器ができる', !!A.social.me, JSON.stringify(A.social.me));

  await A.social.saveProfile('あるく人', '🚶', '#1b6b4a');
  await B.social.saveProfile('ともだち', '🐱', '#2a7fd4');
  await C.social.saveProfile('たにん', '🦊', '#d97706');
  ok('ニックネームとアイコンを保存できる',
     A.social.me.nickname === 'あるく人' && A.social.me.icon_emoji === '🚶');

  let dup = null;
  try { await B.social.saveProfile('あるく人', '🐱', '#2a7fd4'); } catch (e) { dup = e.message; }
  ok('同じニックネームは断られる', !!dup && dup.includes('使われています'), dup || '(通ってしまった)');

  let badName = null;
  try { await A.social.saveProfile('', '🚶', '#1b6b4a'); } catch (e) { badName = e.message; }
  ok('空のニックネームは断られる', !!badName);

  head('「自分だけ」の記録はサーバーに送られない');
  const priv = { id: 'v1', lat: 35.68, lng: 139.76, ts: Date.now(), title: '自宅', comment: '', visibility: 'private' };
  const r0 = await A.social.pushVisit(priv);
  ok('送信そのものが起きない', r0 === null);
  ok('サーバーに1件も無い', db.visits.length === 0, db.visits.length + '件');

  head('「友達だけ」は相互フォローの相手にだけ見える');
  const fr = { id: 'v2', lat: 35.66, lng: 139.74, ts: Date.now(), title: '友達に見せる場所', comment: 'ここ良かった', visibility: 'friends' };
  const r1 = await A.social.pushVisit(fr);
  fr.remoteId = r1.remoteId;
  ok('サーバーに上がった', !!r1.remoteId && db.visits.length === 1);

  await B.social.loadFollows(); await C.social.loadFollows();
  ok('片方向フォローの前: B には見えない', (await B.social.fetchOthers()).length === 0);

  await B.social.follow(A.supa.userId);
  await B.social.loadFollows();
  ok('B→A だけフォローしても、まだ見えない', (await B.social.fetchOthers()).length === 0,
     '片方向で見えたら設計ミス');

  await A.social.follow(B.supa.userId);
  await A.social.loadFollows(); await B.social.loadFollows();
  ok('おたがいにフォローすると友達になる', B.social.isFriend(A.supa.userId) && A.social.isFriend(B.supa.userId));

  const seenByB = await B.social.fetchOthers();
  ok('友達には見える', seenByB.length === 1 && seenByB[0].title === '友達に見せる場所',
     JSON.stringify(seenByB.map(x => x.title)));
  ok('投稿者の名前とアイコンが付く',
     seenByB[0].author.nickname === 'あるく人' && seenByB[0].author.icon_emoji === '🚶');

  await C.social.loadFollows();
  ok('友達でない C には見えない', (await C.social.fetchOthers()).length === 0);

  head('「全体に公開」は誰でも見える');
  const pub = { id: 'v3', lat: 35.70, lng: 139.70, ts: Date.now(), title: 'みんなに見せる場所', comment: '', visibility: 'public' };
  const r2 = await A.social.pushVisit(pub);
  pub.remoteId = r2.remoteId;
  const seenByC = await C.social.fetchOthers();
  ok('友達でなくても見える', seenByC.length === 1 && seenByC[0].title === 'みんなに見せる場所',
     JSON.stringify(seenByC.map(x => x.title)));
  ok('友達には両方見える', (await B.social.fetchOthers()).length === 2);

  head('公開範囲を戻すとサーバーから消える');
  fr.visibility = 'private';
  const r3 = await A.social.pushVisit(fr);
  ok('消したと報告される', r3 && r3.removed === true, JSON.stringify(r3));
  ok('サーバーから消えている', db.visits.length === 1 && db.visits[0].visibility === 'public',
     JSON.stringify(db.visits.map(v => v.visibility)));
  ok('友達からも見えなくなる', (await B.social.fetchOthers()).length === 1);

  head('削除');
  {
    // id を控え損ねていても消せること。控え損ねると、消したつもりのものが
    // 人には見えたまま残る。
    const orphan = { id: 'orphan1', lat: 34.9, lng: 138.9, ts: Date.now(),
                     title: '控え損ねた記録', comment: '', visibility: 'public' };
    await A.social.pushVisit(orphan);
    ok('サーバーにある', db.visits.some(v => v.local_id === 'orphan1'));
    // remoteId を知らない状態を作る
    await A.social.deleteRemote({ id: 'orphan1' });
    ok('端末側の id だけでも消せる', !db.visits.some(v => v.local_id === 'orphan1'),
       JSON.stringify(db.visits.map(v => v.local_id)));
  }
  await A.social.deleteRemote(pub);
  ok('サーバーから消える', db.visits.length === 0);
  ok('誰からも見えない', (await C.social.fetchOthers()).length === 0);

  head('他人の記録は書き換えられない');
  const pub2 = { id: 'v4', lat: 35.5, lng: 139.5, ts: Date.now(), title: 'Aの記録', comment: '', visibility: 'public' };
  const r4 = await A.social.pushVisit(pub2);
  let denied = null;
  try {
    await C.supa.remove('visits', 'id=eq.' + r4.remoteId + '&user_id=eq.' + A.supa.userId);
  } catch (e) { denied = e.message; }
  ok('他人が消そうとすると拒まれる', !!denied && db.visits.length === 1, denied || '(消せてしまった)');

  let denied2 = null;
  try { await C.supa.update('visits', 'id=eq.' + r4.remoteId, { title: '乗っ取り' }); }
  catch (e) { denied2 = e.message; }
  ok('他人が書き換えようとすると拒まれる',
     !!denied2 && db.visits[0].title === 'Aの記録', denied2 || '(書き換えられた)');

  let denied3 = null;
  try { await C.supa.insert('visits', { user_id: A.supa.userId, lat: 0, lng: 0, visited_at: new Date().toISOString(), visibility: 'public' }); }
  catch (e) { denied3 = e.message; }
  ok('他人になりすまして投稿できない', !!denied3, denied3 || '(投稿できてしまった)');

  head('フォローの解除');
  await A.social.unfollow(B.supa.userId);
  await A.social.loadFollows(); await B.social.loadFollows();
  ok('友達でなくなる', !B.social.isFriend(A.supa.userId));

  const fr2 = { id: 'v5', lat: 35.4, lng: 139.4, ts: Date.now(), title: '友達限定2', comment: '', visibility: 'friends' };
  await A.social.pushVisit(fr2);
  const seen = await B.social.fetchOthers();
  ok('解除後は友達限定が見えない', !seen.some(x => x.title === '友達限定2'),
     JSON.stringify(seen.map(x => x.title)));

  head('自分自身はフォローできない');
  let self = null;
  try { await A.social.follow(A.supa.userId); } catch (e) { self = e.message; }
  ok('断られる', !!self, self || '(できてしまった)');

  head('人を探す');
  const found = await A.social.searchPeople('ともだち');
  ok('ニックネームで見つかる', found.length === 1 && found[0].nickname === 'ともだち');
  ok('自分は結果に出ない', !(await A.social.searchPeople('あるく')).some(p => p.id === A.supa.userId));

  head('まとめて同期');
  const many = [
    { id: 'm1', lat: 1, lng: 1, ts: Date.now(), title: 'p1', comment: '', visibility: 'private' },
    { id: 'm2', lat: 2, lng: 2, ts: Date.now(), title: 'f1', comment: '', visibility: 'friends' },
    { id: 'm3', lat: 3, lng: 3, ts: Date.now(), title: 'u1', comment: '', visibility: 'public' },
  ];
  const before = db.visits.length;
  const idmap = await A.social.pushAll(many);
  ok('公開する2件だけ上がる', db.visits.length === before + 2, (db.visits.length - before) + '件');
  ok('private は対応表に載らない', !idmap.m1 && !!idmap.m2 && !!idmap.m3, JSON.stringify(idmap));
  ok('2回目でも増えない (同じ記録は上書き)',
     (await A.social.pushAll(many), db.visits.length) === before + 2, db.visits.length + '件');

  head('モックと schema.sql のずれ');
  {
    const want = schemaSearchColumns();
    await A.social.saveProfile('あるく人', '🚶', '#1b6b4a');
    const got = Object.keys((await C.social.searchPeople('あるく人'))[0] || {})
      .filter(k => !['following', 'followsMe', 'friend', 'blocked'].includes(k)).sort();
    ok('検索が返す列が一致する', JSON.stringify(want) === JSON.stringify(got),
       'schema=' + want.join(',') + ' / mock=' + got.join(','));

    // 画面ごとに列を書き写すと追加が漏れる。まとめ取りでも同じ列が来ること。
    const bulk = await C.social.getProfiles([A.supa.userId]);
    ok('まとめ取りも同じ列', JSON.stringify(Object.keys(bulk[0]).sort()) === JSON.stringify(want),
       Object.keys(bulk[0]).sort().join(','));
  }

  head('写真のアイコン');
  {
    // 1x1 の JPEG の代わりに、中身は何でもよいので判別できるバイト列を使う
    const blob1 = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
    await A.social.setAvatar(blob1);
    ok('プロフィールに結びつく', !!A.social.me.avatar_path, A.social.me.avatar_path);
    ok('自分のフォルダの下に置かれる',
       A.social.me.avatar_path.startsWith(A.supa.userId + '/'), A.social.me.avatar_path);

    const url = A.social.avatarUrl(A.social.me);
    ok('公開URLが作られる', url.includes('/storage/v1/object/public/avatars/'), url);

    // 誰でも (ログインしていなくても) 読めること
    const res = await fetch(url);
    ok('認証なしでも読める', res.status === 200, 'status=' + res.status);

    // 中身がそのまま返ること。文字列として扱うと画像が壊れるので、
    // バイト単位で往復を確かめる。
    const jpegLike = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xD9]);
    await A.social.setAvatar(new Blob([jpegLike], { type: 'image/jpeg' }));
    const back = new Uint8Array(await (await fetch(A.social.avatarUrl(A.social.me))).arrayBuffer());
    ok('バイト列がそのまま戻る', back.length === jpegLike.length && back.every((b, i) => b === jpegLike[i]),
       [...back].join(',') + ' / 送ったのは ' + [...jpegLike].join(','));

    // 他人からもプロフィールに写真が見えること
    const seen = await C.social.searchPeople('あるく人');
    ok('他人からも写真つきで見える', seen.length === 1 && !!seen[0].avatar_path,
       JSON.stringify(seen.map(p => p.avatar_path)));

    // 置き換えると名前が変わり、古いものは消える
    const first = A.social.me.avatar_path;
    await new Promise(r => setTimeout(r, 5));
    await A.social.setAvatar(new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' }));
    ok('置き換えると別の名前になる', A.social.me.avatar_path !== first,
       first + ' → ' + A.social.me.avatar_path);
    ok('古い写真は消える', !db.objects.has('avatars/' + first),
       [...db.objects.keys()].join(', '));

    // 他人のフォルダには置けない
    let denied = null;
    try { await C.supa.upload(A.supa.userId + '/横取り.jpg', blob1, 'avatars'); }
    catch (e) { denied = e.message; }
    ok('他人のフォルダには置けない', !!denied, denied || '(置けてしまった)');

    const second = A.social.me.avatar_path;
    await A.social.clearAvatar();
    ok('やめると絵文字に戻る', A.social.me.avatar_path === null);
    ok('写真も消える', !db.objects.has('avatars/' + second));
  }

  head('いいね');
  {
    await A.social.loadBlocks(); await B.social.loadBlocks(); await C.social.loadBlocks();
    // A の全体公開の記録を用意する
    const shown = { id: 'lk1', lat: 35.1, lng: 139.1, ts: Date.now(), title: 'いいね対象', comment: '', visibility: 'public' };
    const rShown = await A.social.pushVisit(shown);

    let lk = await C.social.fetchLikes([rShown.remoteId]);
    ok('最初は0件', (lk.counts[rShown.remoteId] || 0) === 0 && !lk.mine.has(rShown.remoteId));

    await C.social.like(rShown.remoteId);
    lk = await C.social.fetchLikes([rShown.remoteId]);
    ok('付けると1件になる', lk.counts[rShown.remoteId] === 1 && lk.mine.has(rShown.remoteId));

    // 別の人が付けると2件。自分が付けたかは人ごとに変わる。
    await B.social.like(rShown.remoteId);
    const lkA = await A.social.fetchLikes([rShown.remoteId]);
    ok('2人ぶん数えられる', lkA.counts[rShown.remoteId] === 2, JSON.stringify(lkA.counts));
    ok('自分が付けていなければ mine に入らない', !lkA.mine.has(rShown.remoteId));

    // 二重に押しても増えない
    await C.social.like(rShown.remoteId);
    lk = await C.social.fetchLikes([rShown.remoteId]);
    ok('二度押しても増えない', lk.counts[rShown.remoteId] === 2, String(lk.counts[rShown.remoteId]));

    await C.social.unlike(rShown.remoteId);
    lk = await C.social.fetchLikes([rShown.remoteId]);
    ok('取り消せる', lk.counts[rShown.remoteId] === 1 && !lk.mine.has(rShown.remoteId));

    // 見えない記録にはいいねできない (C は A と友達ではない)
    const secret = { id: 'lk2', lat: 35.2, lng: 139.2, ts: Date.now(), title: '友達限定', comment: '', visibility: 'friends' };
    const rSecret = await A.social.pushVisit(secret);
    let denied = null;
    try { await C.social.like(rSecret.remoteId); } catch (e) { denied = e.message; }
    ok('見えない記録にはいいねできない', !!denied, denied || '(できてしまった)');

    const hidden = await C.social.fetchLikes([rSecret.remoteId]);
    ok('見えない記録のいいねは数えられない', !hidden.counts[rSecret.remoteId]);

    // 他人になりすまして付けられない
    let spoof = null;
    try { await C.supa.insert('likes', { visit_id: rShown.remoteId, user_id: B.supa.userId }); }
    catch (e) { spoof = e.message; }
    ok('他人の名前では付けられない', !!spoof, spoof || '(付けられてしまった)');

    // 自分の記録に付いたいいねを知らせに使える
    const onMine = await A.social.fetchLikesOnMine([rShown.remoteId]);
    ok('自分の記録へのいいねを拾える', onMine.length === 1 && onMine[0].visitId === rShown.remoteId,
       JSON.stringify(onMine.map(x => x.author.nickname)));
    ok('誰が付けたか分かる', !!onMine[0].author.nickname, onMine[0].author.nickname);

    // 記録を消すと、ぶら下がるいいねも消える
    shown.remoteId = rShown.remoteId;
    await A.social.deleteRemote(shown);
    ok('記録を消すといいねも消える', db.likes.filter(l => l.visit_id === rShown.remoteId).length === 0,
       db.likes.length + '件残っている');
  }

  head('ブロック');
  await A.social.loadBlocks(); await C.social.loadBlocks();
  const openPub = { id: 'v9', lat: 36, lng: 140, ts: Date.now(), title: 'Cに見せる', comment: '', visibility: 'public' };
  await A.social.pushVisit(openPub);
  ok('ブロック前は見える', (await C.social.fetchOthers()).some(x => x.title === 'Cに見せる'));

  await C.social.block(A.supa.userId);
  await C.social.loadBlocks();
  ok('ブロックした側からは見えない', !(await C.social.fetchOthers()).some(x => x.title === 'Cに見せる'),
     JSON.stringify((await C.social.fetchOthers()).map(x => x.title)));

  await A.social.loadBlocks();
  ok('ブロックされた側からも相手が見えない', !(await A.social.fetchOthers()).some(x => x.userId === C.supa.userId));

  ok('ブロック一覧に入る', C.social.isBlocked(A.supa.userId));
  ok('ブロックは相手に知られない', (await A.supa.select('blocks', 'select=blocker,blocked')).length === 0,
     '相手のブロック一覧が読めてはいけない');

  await C.social.unblock(A.supa.userId);
  await C.social.loadBlocks();
  ok('解除すると戻る', (await C.social.fetchOthers()).some(x => x.title === 'Cに見せる'));

  let selfBlock = null;
  try { await C.social.block(C.supa.userId); } catch (e) { selfBlock = e.message; }
  ok('自分はブロックできない', !!selfBlock, selfBlock || '(できてしまった)');

  head('通報');
  const seenNow = await C.social.fetchOthers();
  const target = seenNow.find(x => x.title === 'Cに見せる');
  await C.social.report(target, 'offensive', 'テストの通報');
  ok('通報が記録される', db.reports.length === 1 && db.reports[0].reason === 'offensive',
     JSON.stringify(db.reports.map(r => r.reason)));
  ok('通報者が記録される', db.reports[0].reporter === C.supa.userId);
  ok('自分の通報だけ読める', (await C.supa.select('reports', 'select=id')).length === 1 &&
     (await A.supa.select('reports', 'select=id')).length === 0);

  let badReason = null;
  try { await C.social.report(target, 'nonsense', ''); } catch (e) { badReason = e.message; }
  ok('でたらめな理由は拒まれる', !!badReason, badReason || '(通ってしまった)');

  server.close();
  console.log(`\n=== 結果: ${pass} 件成功 / ${fail} 件失敗 ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n落ちました:', e); process.exit(1); });
