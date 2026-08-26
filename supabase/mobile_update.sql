-- ============================================================
-- 모바일에서 빠르게 적용하는 최소 업데이트 (그동안 추가된 컬럼/뷰)
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전.
-- ============================================================
alter table lockers  add column if not exists broken boolean default false;        -- 고장
alter table lockers  add column if not exists needs_reset boolean default false;    -- 초기화 필요
alter table classes  add column if not exists closings jsonb default '{}'::jsonb;   -- 월별 종강일
alter table rentals  add column if not exists bank text;                            -- 은행
alter table rentals  add column if not exists refund_account text;                  -- 환급 계좌
alter table rentals  add column if not exists pay_method text default 'transfer';   -- 이체/현금
alter table rentals  add column if not exists contact_planned boolean default false; -- 연락예정 체크
alter table requests add column if not exists bank text;                            -- 신청 은행

-- 학생 개인별 메모(직원 공유) — 이름+생년월일 기준
create table if not exists student_notes (
  id           bigint generated always as identity primary key,
  student_name text not null,
  birth        text not null default '',
  body         text not null default '',
  updated_by   text,
  updated_at   timestamptz default now(),
  unique (student_name, birth)
);
alter table student_notes enable row level security;
drop policy if exists "snotes_all" on student_notes;
create policy "snotes_all" on student_notes for all to authenticated using (true) with check (true);
do $$ begin alter publication supabase_realtime add table student_notes; exception when duplicate_object then null; end $$;

-- 학생용 공개 뷰: 초기화 필요는 학생에게 '사용중'으로 보이게 occupied 에 포함
drop view if exists public.locker_status;
create view public.locker_status as
select l.floor, l.number, l.col, l."row", l.is_tall, l.broken,
  (exists (select 1 from rentals r where r.locker_id = l.id and r.active) or l.needs_reset) as occupied,
  exists (select 1 from requests q where q.floor = l.floor and q.number = l.number) as pending
from lockers l;
grant select on public.locker_status to anon, authenticated;
