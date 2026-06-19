-- ============================================================
-- 서면 YBM 사물함 관리 — 스키마 (Supabase SQL Editor 에서 실행)
-- 마감일 = (학생이 듣는 반의 종강일) + 10일  → 저장하지 않고 조회 시 계산
-- 이 스크립트는 여러 번 실행해도 안전합니다.
-- ============================================================

-- 반(강좌) 마스터 : 카테고리 + 반이름 + 현재 종강일
create table if not exists classes (
  id            bigint generated always as identity primary key,
  category      text not null,          -- 토익, 토익스피킹, 회화, 오픽, 토플, 아이엘츠, 일본어 ...
  name          text not null,          -- 역전토익, 첫토익 ...
  closing_date  date,                   -- 이번 텀 종강일 (관리자가 매달 갱신, 비어 있을 수 있음)
  sort          int default 0,
  created_at    timestamptz default now(),
  unique (category, name)
);

-- 사물함 마스터
create table if not exists lockers (
  id        bigint generated always as identity primary key,
  floor     int  not null,            -- 1,2,3,4,7 / 2관=8
  number    int  not null,            -- 층 내 표시 번호
  col       int  not null,            -- 격자 위치(가로)
  "row"     int  not null,            -- 격자 위치(세로)
  is_tall   boolean default false,    -- 키 큰 칸 여부(맨 윗줄)
  broken    boolean default false,    -- 고장 표시
  unique (floor, number)
);

-- 현재/과거 대여 (칸당 활성 대여는 1건)
create table if not exists rentals (
  id              bigint generated always as identity primary key,
  locker_id       bigint not null references lockers(id),
  student_name    text not null,
  phone           text,                    -- 마감 시 연락용 전화번호
  class_id        bigint references classes(id),  -- 학생이 듣는 반(마감일 계산 기준)
  started_on      date not null default current_date,
  deposit_held    boolean default true,    -- 보증금 수령 여부
  active          boolean default true,
  created_at      timestamptz default now()
);

-- 기존 설치 업그레이드용(이미 rentals 가 있던 경우 컬럼 추가)
alter table rentals add column if not exists phone    text;
alter table rentals add column if not exists class_id bigint references classes(id);
alter table rentals add column if not exists birth    text;            -- 생년월일 6자리(YYMMDD)
alter table rentals add column if not exists extended_months int default 0;  -- 연장(개월)
alter table rentals add column if not exists refund_account text;     -- 보증금 환급받을 계좌
alter table lockers add column if not exists broken boolean default false;   -- 고장 표시(기존 설치 업그레이드용)

-- 칸당 활성 대여 1건만 허용
create unique index if not exists rentals_one_active_per_locker
  on rentals(locker_id) where active;

-- 이력 로그
create table if not exists rental_logs (
  id          bigint generated always as identity primary key,
  locker_id   bigint references lockers(id),
  action      text not null,   -- 'rent' | 'return' | 'move' | 'edit' | 'class_closing'
  detail      jsonb,
  created_at  timestamptz default now()
);

-- ============================================================
-- RLS: 로그인한(authenticated) 직원만 접근
-- ============================================================
alter table classes      enable row level security;
alter table lockers      enable row level security;
alter table rentals      enable row level security;
alter table rental_logs  enable row level security;

drop policy if exists "classes_all"    on classes;
drop policy if exists "lockers_read"   on lockers;
drop policy if exists "lockers_update" on lockers;
drop policy if exists "rentals_read"   on rentals;
drop policy if exists "rentals_insert" on rentals;
drop policy if exists "rentals_update" on rentals;
drop policy if exists "logs_read"      on rental_logs;
drop policy if exists "logs_insert"    on rental_logs;
drop policy if exists "logs_update"    on rental_logs;
drop policy if exists "logs_delete"    on rental_logs;

-- 반은 직원이 추가/수정/삭제까지 가능
create policy "classes_all"    on classes     for all    to authenticated using (true) with check (true);
create policy "lockers_read"   on lockers     for select to authenticated using (true);
create policy "lockers_update" on lockers     for update to authenticated using (true) with check (true);  -- 고장 표시 토글
create policy "rentals_read"   on rentals     for select to authenticated using (true);
create policy "rentals_insert" on rentals     for insert to authenticated with check (true);
create policy "rentals_update" on rentals     for update to authenticated using (true) with check (true);
create policy "logs_read"      on rental_logs for select to authenticated using (true);
create policy "logs_insert"    on rental_logs for insert to authenticated with check (true);
create policy "logs_update"    on rental_logs for update to authenticated using (true) with check (true);
create policy "logs_delete"    on rental_logs for delete to authenticated using (true);

-- ============================================================
-- Realtime: 멀티 PC 동기화 (rentals + classes 변경 브로드캐스트)
-- ============================================================
do $$ begin alter publication supabase_realtime add table rentals; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table lockers; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table classes; exception when duplicate_object then null; end $$;

-- ============================================================
-- 학생 신청 대기 (학생이 직접 신청 → 직원이 수락)
-- 학생(anon)은 INSERT만 가능(개인정보는 못 읽음), 직원은 조회/삭제
-- ============================================================
create table if not exists requests (
  id             bigint generated always as identity primary key,
  floor          int  not null,
  number         int  not null,
  student_name   text not null,
  birth          text,
  phone          text,
  refund_account text,
  created_at     timestamptz default now()
);

alter table requests enable row level security;
drop policy if exists "requests_insert" on requests;
drop policy if exists "requests_select" on requests;
drop policy if exists "requests_delete" on requests;
create policy "requests_insert" on requests for insert to anon, authenticated with check (true);
create policy "requests_select" on requests for select to authenticated using (true);
create policy "requests_delete" on requests for delete to authenticated using (true);

do $$ begin alter publication supabase_realtime add table requests; exception when duplicate_object then null; end $$;

-- ============================================================
-- 학생용 공개 조회 뷰 (student.html)
-- 개인정보(이름·전화)는 노출하지 않고 '빈/사용중/신청중'만 공개.
-- ============================================================
create or replace view public.locker_status as
select
  l.floor,
  l.number,
  l.col,
  l."row",
  l.is_tall,
  l.broken,
  exists (select 1 from rentals r where r.locker_id = l.id and r.active) as occupied,
  exists (select 1 from requests q where q.floor = l.floor and q.number = l.number) as pending
from lockers l;

grant select on public.locker_status to anon, authenticated;

-- ============================================================
-- 특별공지 (직원 간 빠른 공유) — 화면 최상단 고정 표시
-- ============================================================
create table if not exists notices (
  id            bigint generated always as identity primary key,
  body          text not null,
  author        text,                    -- 작성자 표시 이름
  author_email  text,
  created_at    timestamptz default now()
);

alter table notices enable row level security;
drop policy if exists "notices_read"   on notices;
drop policy if exists "notices_insert" on notices;
drop policy if exists "notices_delete" on notices;
create policy "notices_read"   on notices for select to authenticated using (true);
create policy "notices_insert" on notices for insert to authenticated with check (true);
create policy "notices_delete" on notices for delete to authenticated using (true);

do $$ begin alter publication supabase_realtime add table notices; exception when duplicate_object then null; end $$;

-- ============================================================
-- 앱 설정 (편집 가능한 문구 등) — 사물함 이용 안내(초기 비밀번호/변경 방법)
-- ============================================================
create table if not exists app_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz default now()
);

insert into app_settings (key, value) values
  ('password_guide', E'비밀번호는 1004입니다.\n비밀번호 변경은 사물함 안쪽에 안내되어 있으니 참고 부탁드립니다.')
on conflict (key) do nothing;

alter table app_settings enable row level security;
drop policy if exists "settings_read"  on app_settings;
drop policy if exists "settings_write" on app_settings;
create policy "settings_read"  on app_settings for select to authenticated using (true);
create policy "settings_write" on app_settings for all    to authenticated using (true) with check (true);

do $$ begin alter publication supabase_realtime add table app_settings; exception when duplicate_object then null; end $$;
