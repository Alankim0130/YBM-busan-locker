-- ============================================================
-- 서면 YBM 사물함 관리 — 스키마 (Supabase SQL Editor 에서 실행)
-- 상태(free/rent/due/over)는 저장하지 않고 조회 시 계산합니다.
-- 이 스크립트는 여러 번 실행해도 안전하도록 작성되었습니다.
-- ============================================================

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
  started_on      date not null default current_date,
  deposit_held    boolean default true,   -- 보증금 수령 여부
  confirmed_month text,                    -- 마지막 갱신 확인 달 'YYYY-MM'
  active          boolean default true,
  created_at      timestamptz default now()
);

-- 칸당 활성 대여 1건만 허용
create unique index if not exists rentals_one_active_per_locker
  on rentals(locker_id) where active;

-- 이력 로그
create table if not exists rental_logs (
  id          bigint generated always as identity primary key,
  locker_id   bigint references lockers(id),
  action      text not null,   -- 'rent' | 'return' | 'renew_confirm'
  detail      jsonb,
  created_at  timestamptz default now()
);

-- ============================================================
-- RLS: 로그인한(authenticated) 직원만 접근
-- ============================================================
alter table lockers      enable row level security;
alter table rentals      enable row level security;
alter table rental_logs  enable row level security;

drop policy if exists "lockers_read"   on lockers;
drop policy if exists "rentals_read"   on rentals;
drop policy if exists "rentals_insert" on rentals;
drop policy if exists "rentals_update" on rentals;
drop policy if exists "logs_read"      on rental_logs;
drop policy if exists "logs_insert"    on rental_logs;

create policy "lockers_read"   on lockers     for select to authenticated using (true);
create policy "rentals_read"   on rentals     for select to authenticated using (true);
create policy "rentals_insert" on rentals     for insert to authenticated with check (true);
create policy "rentals_update" on rentals     for update to authenticated using (true) with check (true);
create policy "logs_read"      on rental_logs for select to authenticated using (true);
create policy "logs_insert"    on rental_logs for insert to authenticated with check (true);

-- ============================================================
-- Realtime: 멀티 PC 동기화를 위해 rentals 변경을 브로드캐스트
-- ============================================================
do $$
begin
  alter publication supabase_realtime add table rentals;
exception
  when duplicate_object then null;  -- 이미 추가되어 있으면 무시
end $$;
