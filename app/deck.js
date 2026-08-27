'use strict';

/* =========================================================================
   deck.js — ゲーム定義・デッキリストの解析・カードの共有モデル
   確率ラボ (app.js) と一人回し (solo.js) の両方から使う。
   ========================================================================= */

(function (global) {

  /* ---------- ゲーム定義 ---------------------------------------------------
     枚数やゾーン構成は画面から編集できるようにしてある。ここにあるのは
     あくまで初期値で、実際のルールに合わせて上書きして使う前提。
     ------------------------------------------------------------------------ */
  const GAMES = {
    pokemon: {
      label: 'ポケモンカード',
      deckMin: 60, deckMax: 60, hand: 7, maxCopies: 4,
      deckName: '山札', discardName: 'トラッシュ',
      categories: ['ポケモン', 'サポート', 'グッズ', 'どうぐ', 'スタジアム', 'エネルギー'],
      // マリガン判定に使うフラグ。ポケカは「たねポケモンが手札にあること」が条件。
      flagA: { key: 'basic', label: 'たね', cats: ['ポケモン'] },
      flagB: { key: 'draw', label: 'ドロー', cats: ['サポート'] },
      mulligan: 'basic',
      firstTurnNoDraw: false,
      aside: { id: 'aside', name: 'サイド', count: 6 },
      extra: null,
      zones: [
        { id: 'active',  name: 'バトル場',     max: 1 },
        { id: 'bench',   name: 'ベンチ',       max: 5 },
        { id: 'stadium', name: 'スタジアム',   max: 1 },
        { id: 'lost',    name: 'ロストゾーン', max: 0 },
      ],
    },

    duelmasters: {
      label: 'デュエル・マスターズ',
      deckMin: 40, deckMax: 40, hand: 5, maxCopies: 4,
      deckName: '山札', discardName: '墓地',
      categories: ['クリーチャー', '呪文', 'その他'],
      flagA: null,
      flagB: { key: 'draw', label: 'ドロー', cats: ['クリーチャー', '呪文', 'その他'] },
      mulligan: 'none',
      firstTurnNoDraw: true,
      aside: { id: 'aside', name: 'シールド', count: 5 },
      extra: { id: 'extra', name: '超次元・GRゾーン', max: 12 },
      zones: [
        { id: 'battle', name: 'バトルゾーン', max: 0 },
        { id: 'mana',   name: 'マナゾーン',   max: 0 },
      ],
    },

    yugioh: {
      label: '遊戯王',
      deckMin: 40, deckMax: 60, hand: 5, maxCopies: 3,
      deckName: 'デッキ', discardName: '墓地',
      categories: ['モンスター', '魔法', '罠'],
      flagA: null,
      flagB: { key: 'draw', label: 'ドロー', cats: ['モンスター', '魔法', '罠'] },
      mulligan: 'none',
      firstTurnNoDraw: true,
      aside: null,
      extra: { id: 'extra', name: 'エクストラデッキ', max: 15 },
      zones: [
        { id: 'monster', name: 'モンスターゾーン', max: 5 },
        { id: 'spell',   name: '魔法・罠ゾーン',   max: 5 },
        { id: 'field',   name: 'フィールドゾーン', max: 1 },
        { id: 'banish',  name: '除外',             max: 0 },
      ],
    },
  };

  const GAME_IDS = Object.keys(GAMES);
  const DEFAULT_GAME = 'pokemon';
  function game(id) { return GAMES[id] || GAMES[DEFAULT_GAME]; }

  /* ---------- カード名からの推測用データ ------------------------------------
     入力を楽にするための目安。UI 側で必ず上書きできるようにしてある。
     ------------------------------------------------------------------------ */
  const SUPPORTER_NAMES = [
    '博士の研究', 'ナンジャモ', 'ボスの指令', 'ペパー', 'アカマツ', 'ネモ', 'オモダカ', 'カイ',
    'セレナ', 'リーリエ', 'マリィ', 'シロナ', 'キハダ', 'ジャッジマン', 'エリカのおもてなし',
    'クセロシキ', 'スグリ', 'ブライア', 'サナ', 'アンズ', 'マツバ',
    "professor's research", 'iono', "boss's orders", 'boss’s orders', 'arven', 'nemona', 'judge',
    'cynthia', 'marnie', 'lillie', "erika's invitation", 'briar', 'crispin',
    'professor turo', 'professor sada', 'colress', 'guzma', 'serena', 'penny', 'carmine',
  ];
  const DRAW_SUPPORTER_NAMES = [
    '博士の研究', 'ナンジャモ', 'キハダ', 'ネモ', 'シロナ', 'マリィ', 'リーリエ', 'ジャッジマン', 'サナ',
    "professor's research", 'iono', 'nemona', 'judge', 'cynthia', 'marnie', 'lillie',
    'professor turo', 'professor sada', 'colress',
  ];
  const STADIUM_HINT = ['スタジアム', 'ジム', 'タワー', '神殿', '遺跡', 'スタジオ', 'stadium', 'gym'];
  const TOOL_HINT = ['のどうぐ', 'ベルト', 'おまもり', 'チョッキ', 'tool', 'vest', 'band', 'charm'];
  const ENERGY_HINT = ['エネルギー', 'energy'];
  const BASIC_ENERGY_HINT = ['基本'];

  function norm(s) { return String(s).trim().toLowerCase(); }
  function hasAny(name, list) {
    const n = norm(name);
    return list.some(w => n.includes(norm(w)));
  }

  /** 基本エネルギーは4枚制限の対象外。名前からの推測なので確実ではない。 */
  function isUnlimited(card, gid) {
    if (gid !== 'pokemon') return false;
    return card.cat === 'エネルギー' && hasAny(card.name, BASIC_ENERGY_HINT);
  }

  /* ---------- デッキリストの解析 -------------------------------------------- */

  /** 見出し行 → 意味。value が null の行は読み飛ばす。 */
  const SECTIONS = [
    // 別の山として扱うもの
    { re: /^(エクストラ(デッキ)?|ＥＸデッキ|exデッキ|extra\s*deck)$/i,      kind: 'extra' },
    { re: /^(超次元(ゾーン)?|超gr(ゾーン)?|gr(ゾーン)?|超次元・gr(ゾーン)?)$/i, kind: 'extra' },
    { re: /^(サイド(デッキ)?|side\s*deck)$/i,                              kind: 'side' },
    { re: /^(メイン(デッキ)?|main\s*deck)$/i,                              kind: 'main' },
    // 種別の見出し
    { re: /^(pok[eé]mon|ポケモン)$/i,          cat: 'ポケモン' },
    { re: /^(energy|エネルギー)$/i,            cat: 'エネルギー' },
    { re: /^(サポート|supporter)$/i,           cat: 'サポート' },
    { re: /^(グッズ|item)$/i,                  cat: 'グッズ' },
    { re: /^(スタジアム|stadium)$/i,           cat: 'スタジアム' },
    { re: /^(どうぐ|ポケモンのどうぐ|tool)$/i, cat: 'どうぐ' },
    { re: /^(trainer|トレーナー)$/i,           cat: 'グッズ' },
    { re: /^(クリーチャー|creature)$/i,        cat: 'クリーチャー' },
    { re: /^(呪文|spell)$/i,                   cat: '呪文' },
    { re: /^(モンスター|monster)$/i,           cat: 'モンスター' },
    { re: /^(魔法|magic)$/i,                   cat: '魔法' },
    { re: /^(罠|トラップ|trap)$/i,             cat: '罠' },
    // 合計行などは無視
    { re: /^(total\s*cards?|合計|計|枚数)$/i,  cat: null },
  ];

  /** PTCGL 書き出しの末尾セット記号 (例: " SVI 181", " PAF 91") を落とす */
  function stripSetCode(name) {
    return name
      .replace(/\s+[A-Z]{2,5}\s+\d+[a-zA-Z]?\s*$/, '')
      .replace(/\s+(?:PH|RH)\s*$/i, '')
      .trim();
  }

  /** 見出し行なら {kind|cat} を返す。違えば null。 */
  function sectionOf(line) {
    const head = line.replace(/[:：]\s*\d*\s*$/, '').replace(/\s+\d+\s*$/, '').trim();
    if (!head) return null;
    for (const s of SECTIONS) {
      if (s.re.test(head)) return s;
    }
    return null;
  }

  function guessCategory(name, sectionCat, gid) {
    const g = game(gid);
    const cats = g.categories;
    if (sectionCat && cats.includes(sectionCat)) {
      // ポケカでは見出しが「トレーナー」でも、名前からサポート等に振り分ける
      if (gid === 'pokemon' && sectionCat === 'グッズ') {
        if (hasAny(name, ENERGY_HINT)) return 'エネルギー';
        if (hasAny(name, SUPPORTER_NAMES)) return 'サポート';
        if (hasAny(name, TOOL_HINT)) return 'どうぐ';
        if (hasAny(name, STADIUM_HINT)) return 'スタジアム';
      }
      return sectionCat;
    }
    if (gid === 'pokemon') {
      if (hasAny(name, ENERGY_HINT)) return 'エネルギー';
      if (hasAny(name, SUPPORTER_NAMES)) return 'サポート';
      if (hasAny(name, TOOL_HINT)) return 'どうぐ';
      if (hasAny(name, STADIUM_HINT)) return 'スタジアム';
      return 'グッズ';
    }
    return cats[0];
  }

  /**
   * デッキリストを解析する。
   * 「4 カード名」「カード名 4」の両方と、PTCGL 書き出し形式に対応する。
   * エクストラデッキ / 超次元ゾーンの見出しがあれば extra:true を立てる。
   */
  function parseDeck(text, gid) {
    gid = GAMES[gid] ? gid : DEFAULT_GAME;
    const g = game(gid);
    const cards = [];
    let sectionCat = null;
    let pile = 'main';

    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;

      const sec = sectionOf(line);
      if (sec) {
        if (sec.kind) pile = sec.kind === 'main' ? 'main' : sec.kind;
        else sectionCat = sec.cat;
        continue;
      }

      let count = null, name = null;
      let m = line.match(/^(\d{1,2})\s*[x×]?\s+(.+)$/);          // 「4 カード名」
      if (m) { count = +m[1]; name = m[2]; }
      else {
        m = line.match(/^(.+?)\s+[x×]?\s*(\d{1,2})\s*(?:枚)?$/);  // 「カード名 4」
        if (m) { name = m[1]; count = +m[2]; }
      }
      if (count === null || !name) continue;

      name = stripSetCode(name).replace(/\s{2,}/g, ' ').trim();
      if (!name || count < 1 || count > 60) continue;

      const existing = cards.find(c => c.name === name && c.pile === pile);
      if (existing) { existing.count += count; continue; }

      const cat = guessCategory(name, sectionCat, gid);
      const card = { name, count, cat, pile };
      if (g.flagA) card[g.flagA.key] = g.flagA.cats.includes(cat);
      if (g.flagB) card[g.flagB.key] = g.flagB.cats.includes(cat) && hasAny(name, DRAW_SUPPORTER_NAMES);
      cards.push(card);
    }
    return cards;
  }

  /* ---------- 保存 ---------------------------------------------------------
     デッキ本体は両アプリで共有する。画面ごとの設定は各アプリが別キーで持つ。
     ------------------------------------------------------------------------ */
  const KEY_DECK = 'tcg-deck-v1';
  const KEY_LEGACY = 'deck-prob-lab-v1';   // 旧: デッキと設定が同居していた

  function saveDeck(gid, text, cards) {
    try { localStorage.setItem(KEY_DECK, JSON.stringify({ game: gid, text, cards })); }
    catch (e) { /* プライベートモード等では保存できない。無視して続行する */ }
  }

  function loadDeck() {
    try {
      const raw = localStorage.getItem(KEY_DECK);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.cards) && d.cards.length) {
          return { game: GAMES[d.game] ? d.game : DEFAULT_GAME, text: d.text || '', cards: d.cards };
        }
        return null;
      }
      const old = localStorage.getItem(KEY_LEGACY);   // 旧キーからの移行
      if (!old) return null;
      const d = JSON.parse(old);
      if (!d || !Array.isArray(d.cards) || !d.cards.length) return null;
      d.cards.forEach(c => { if (!c.pile) c.pile = 'main'; });
      saveDeck(DEFAULT_GAME, d.text || '', d.cards);
      return { game: DEFAULT_GAME, text: d.text || '', cards: d.cards };
    } catch (e) { return null; }
  }

  function clearDeck() {
    try { localStorage.removeItem(KEY_DECK); localStorage.removeItem(KEY_LEGACY); }
    catch (e) { /* 保存不可でも問題ない */ }
  }

  /* ---------- 山札の実体化 -------------------------------------------------- */

  /** 同名カードも1枚ずつ区別できるよう uid を振って配列に展開する。 */
  function materialize(cards, pile) {
    const out = [];
    let uid = 0;
    cards.forEach((c, ci) => {
      if ((c.pile || 'main') !== pile) { uid += c.count; return; }
      for (let k = 0; k < c.count; k++) {
        out.push({ uid: 'c' + ci + '_' + k, name: c.name, cat: c.cat,
                   basic: !!c.basic, draw: !!c.draw });
      }
    });
    return out;
  }

  /** Fisher-Yates */
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * 山札から初手を配る。deck は破壊的に扱うので、複製した配列を渡すこと。
   * rule = 'basic' のときだけ、条件を満たすまで手札を戻して引き直す。
   * 山札全体に該当カードが1枚も無い場合は引き直しても無意味なのでそのまま返す。
   */
  function dealOpening(deck, handSize, rule, flagKey) {
    const key = flagKey || 'basic';
    const anyFlagged = deck.some(c => c[key]);
    let mulligans = 0;
    for (let guard = 0; guard < 200; guard++) {
      const hand = deck.splice(0, Math.min(handSize, deck.length));
      if (rule !== 'basic' || !anyFlagged) return { hand, mulligans };
      if (hand.some(c => c[key])) return { hand, mulligans };
      deck.push(...hand);
      shuffle(deck);
      mulligans++;
    }
    return { hand: deck.splice(0, Math.min(handSize, deck.length)), mulligans };
  }

  function countIn(cards, pile) {
    return cards.reduce((s, c) => s + ((c.pile || 'main') === pile ? c.count : 0), 0);
  }

  global.DeckLib = {
    GAMES, GAME_IDS, DEFAULT_GAME, game,
    parseDeck, stripSetCode, guessCategory, isUnlimited, hasAny,
    saveDeck, loadDeck, clearDeck, materialize, shuffle, countIn, dealOpening,
  };

})(typeof window !== 'undefined' ? window : globalThis);
