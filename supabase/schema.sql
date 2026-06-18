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
  floor     int  not null,            -- 1,2,3,7
  number    int  not null,            -- 층 내 표시 번호
  col       int  not null,            -- 격자 위치(가로)
  "row"     int  not null,            -- 격자 위치(세로)
  is_tall   boolean default false,    -- 키 큰 칸 여부(맨 윗줄)
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
drop policy if exists "rentals_read"   on rentals;
drop policy if exists "rentals_insert" on rentals;
drop policy if exists "rentals_update" on rentals;
drop policy if exists "logs_read"      on rental_logs;
drop policy if exists "logs_insert"    on rental_logs;

-- 반은 직원이 추가/수정/삭제까지 가능
create policy "classes_all"    on classes     for all    to authenticated using (true) with check (true);
create policy "lockers_read"   on lockers     for select to authenticated using (true);
create policy "rentals_read"   on rentals     for select to authenticated using (true);
create policy "rentals_insert" on rentals     for insert to authenticated with check (true);
create policy "rentals_update" on rentals     for update to authenticated using (true) with check (true);
create policy "logs_read"      on rental_logs for select to authenticated using (true);
create policy "logs_insert"    on rental_logs for insert to authenticated with check (true);

-- ============================================================
-- Realtime: 멀티 PC 동기화 (rentals + classes 변경 브로드캐스트)
-- ============================================================
do $$ begin alter publication supabase_realtime add table rentals; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table classes; exception when duplicate_object then null; end $$;
