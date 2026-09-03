'use strict';

/* =========================================================================
   config.js — このアプリがつなぐ先
   ここに入れておくと、使う人は URL やキーを打ち込まずに、
   メールアドレスとパスワードだけで始められる。

   ここに書くキーは「公開してよいキー」(anon / publishable) だけ。
   公開ページに載るものなので、Secret key / service_role は絶対に書かない。
   実際の保護は schema.sql の行レベルセキュリティが行う。

   空のままなら、これまでどおりアプリの画面から手で設定できる。
   ========================================================================= */

window.TRAILMAP_SUPABASE = {
  url: 'https://pvzppkyzxrzzylvtawod.supabase.co',
  anonKey: 'sb_publishable_Tz-KwPD59sAZ_dG05b-g2w_SG3UWec_',
};

// 通報や不具合の連絡先 (App Store のガイドラインで掲載が求められている)
window.TRAILMAP_CONTACT = 'nswtmk@gmail.com';
