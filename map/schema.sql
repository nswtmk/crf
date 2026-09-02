-- =========================================================================
-- 足あと地図 — Supabase のデータベース設計
--
-- 使い方: Supabase の SQL Editor にこのファイルの内容を丸ごと貼って実行する。
--         何度実行しても同じ結果になるように書いてある。
--
-- 設計の要点:
--   公開範囲の判定は「行レベルセキュリティ(RLS)」でデータベース自身にやらせる。
--   アプリ側の画面で出し分けるだけでは、通信を直接叩かれたら守れないため。
--   「自分だけ」の記録はそもそもここに送らない (端末の中だけに置く)。
-- =========================================================================

-- ---------------------------------------------------------------- プロフィール
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 20),
  icon_emoji  text not null default '🐾' check (char_length(icon_emoji) <= 8),
  icon_color  text not null default '#1b6b4a' check (icon_color ~ '^#[0-9a-fA-F]{6}$'),
  created_at  timestamptz not null default now()
);
comment on table public.profiles is 'ニックネームとアイコン。誰でも読める。';

-- ニックネームは大文字小文字を区別せず一意にする (検索して見つけてもらうため)
create unique index if not exists profiles_nickname_key
  on public.profiles (lower(nickname));

-- ------------------------------------------------------------------ フォロー
create table if not exists public.follows (
  follower   uuid not null references public.profiles(id) on delete cascade,
  followee   uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  constraint no_self_follow check (follower <> followee)
);
create index if not exists follows_followee_idx on public.follows (followee);

-- 相互にフォローしていれば「友達」とみなす。
-- 片方向だと、勝手にフォローするだけで友達限定の記録が見えてしまうため。
create or replace function public.is_friend(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from follows where follower = a and followee = b)
     and exists (select 1 from follows where follower = b and followee = a);
$$;

-- ------------------------------------------------------------ ブロック・通報
-- App Store のガイドライン 1.2 は、利用者が投稿できるアプリに
-- 「不適切な内容を通報できること」「相手をブロックできること」を求めている。
create table if not exists public.blocks (
  blocker    uuid not null references public.profiles(id) on delete cascade,
  blocked    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  constraint no_self_block check (blocker <> blocked)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked);

-- どちらかがブロックしていれば、おたがいに見えなくする
create or replace function public.is_blocked(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from blocks
    where (blocker = a and blocked = b) or (blocker = b and blocked = a)
  );
$$;

-- -------------------------------------------------------------------- 記録
create table if not exists public.visits (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  local_id    text,                      -- 端末側の id。二重に上がるのを防ぐ
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  visited_at  timestamptz not null,
  title       text not null default '' check (char_length(title) <= 80),
  comment     text not null default '' check (char_length(comment) <= 2000),
  visibility  text not null check (visibility in ('friends', 'public')),
  created_at  timestamptz not null default now()
);
comment on column public.visits.visibility is
  '友達(相互フォロー)のみ か 全体公開。「自分だけ」はここに送らない。';

create index if not exists visits_user_idx on public.visits (user_id, visited_at desc);
create index if not exists visits_public_idx on public.visits (visited_at desc)
  where visibility = 'public';
create unique index if not exists visits_local_key
  on public.visits (user_id, local_id) where local_id is not null;

-- -------------------------------------------------------------------- 通報
create table if not exists public.reports (
  id         uuid primary key default gen_random_uuid(),
  reporter   uuid not null references public.profiles(id) on delete cascade,
  visit_id   uuid references public.visits(id) on delete cascade,
  target     uuid references public.profiles(id) on delete cascade,
  reason     text not null check (reason in ('spam','offensive','private','other')),
  note       text not null default '' check (char_length(note) <= 1000),
  status     text not null default 'open' check (status in ('open','done')),
  created_at timestamptz not null default now()
);
create index if not exists reports_open_idx on public.reports (created_at desc) where status = 'open';

-- -------------------------------------------------------------------- 写真
create table if not exists public.photos (
  id         uuid primary key default gen_random_uuid(),
  visit_id   uuid not null references public.visits(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  path       text not null,              -- ストレージ上の位置 <visit_id>/<uuid>.jpg
  created_at timestamptz not null default now()
);
create index if not exists photos_visit_idx on public.photos (visit_id);

-- =========================================================================
-- 行レベルセキュリティ
-- =========================================================================
alter table public.profiles enable row level security;
alter table public.follows  enable row level security;
alter table public.visits   enable row level security;
alter table public.photos   enable row level security;
alter table public.blocks   enable row level security;
alter table public.reports  enable row level security;

-- ---- プロフィール: 誰でも読める。書けるのは本人だけ。
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select using (true);

drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete using (auth.uid() = id);

-- ---- フォロー: 誰でも読める (フォロワー数の表示に使う)。増減できるのは本人の行だけ。
drop policy if exists follows_read on public.follows;
create policy follows_read on public.follows
  for select using (true);

drop policy if exists follows_insert on public.follows;
create policy follows_insert on public.follows
  for insert with check (auth.uid() = follower);

drop policy if exists follows_delete on public.follows;
create policy follows_delete on public.follows
  for delete using (auth.uid() = follower);

-- ---- ブロック: 自分がブロックした一覧だけ読める。相手には知らせない。
drop policy if exists blocks_read on public.blocks;
create policy blocks_read on public.blocks
  for select using (auth.uid() = blocker);

drop policy if exists blocks_insert on public.blocks;
create policy blocks_insert on public.blocks
  for insert with check (auth.uid() = blocker);

drop policy if exists blocks_delete on public.blocks;
create policy blocks_delete on public.blocks
  for delete using (auth.uid() = blocker);

-- ---- 通報: 出すのは誰でも。読めるのは自分が出した分だけ。
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert with check (auth.uid() = reporter);

drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports
  for select using (auth.uid() = reporter);

-- ---- 記録: ここが公開範囲の本体
drop policy if exists visits_read on public.visits;
create policy visits_read on public.visits
  for select using (
    (
      auth.uid() = user_id                                 -- 自分のもの
      or visibility = 'public'                             -- 全体公開
      or (visibility = 'friends' and public.is_friend(auth.uid(), user_id))
    )
    -- ブロックしている / されている相手のものは、公開設定に関わらず出さない
    and (auth.uid() = user_id or not public.is_blocked(auth.uid(), user_id))
  );

drop policy if exists visits_insert on public.visits;
create policy visits_insert on public.visits
  for insert with check (auth.uid() = user_id);

drop policy if exists visits_update on public.visits;
create policy visits_update on public.visits
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists visits_delete on public.visits;
create policy visits_delete on public.visits
  for delete using (auth.uid() = user_id);

-- ---- 写真: ぶら下がっている記録が見えるなら見える
drop policy if exists photos_read on public.photos;
create policy photos_read on public.photos
  for select using (
    exists (select 1 from public.visits v where v.id = visit_id)
  );

drop policy if exists photos_insert on public.photos;
create policy photos_insert on public.photos
  for insert with check (auth.uid() = user_id);

drop policy if exists photos_delete on public.photos;
create policy photos_delete on public.photos
  for delete using (auth.uid() = user_id);

-- =========================================================================
-- 写真の置き場 (ストレージ)
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

-- 自分のフォルダ (<自分のid>/...) にだけ置ける
drop policy if exists photos_upload on storage.objects;
create policy photos_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists photos_remove on storage.objects;
create policy photos_remove on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- 読めるのは、その写真がぶら下がる記録が見えるとき
drop policy if exists photos_view on storage.objects;
create policy photos_view on storage.objects
  for select to authenticated
  using (
    bucket_id = 'photos'
    and exists (select 1 from public.photos p where p.path = storage.objects.name)
  );

-- =========================================================================
-- サインアップ時にプロフィールの器を用意する
-- =========================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, 'user' || substr(replace(new.id::text, '-', ''), 1, 8))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================================
-- ニックネームで人を探す (プロフィール表を直接検索させない)
-- =========================================================================
create or replace function public.search_profiles(q text)
returns table (id uuid, nickname text, icon_emoji text, icon_color text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.nickname, p.icon_emoji, p.icon_color
  from profiles p
  where p.nickname ilike '%' || q || '%'
  order by (lower(p.nickname) = lower(q)) desc, char_length(p.nickname)
  limit 20;
$$;
