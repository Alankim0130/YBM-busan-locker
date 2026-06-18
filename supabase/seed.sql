-- ============================================================
-- 시드 (schema.sql 실행 후 실행) — 여러 번 실행해도 안전
-- ============================================================

-- ---------- 반(강좌) ----------
-- closing_date 는 비워둠. 관리자가 앱의 '반 관리'에서 매달 종강일을 입력.
insert into classes (category, name, sort) values
  ('토익',       '역전토익',        1),
  ('토익',       '첫토익',          2),
  ('토익',       '벨라토익',        3),
  ('토익',       '밀착토익',        4),
  ('토익',       '독한토익',        5),
  ('토익스피킹', '폴린토익스피킹',  10),
  ('회화',       '브라이언회화',    20),
  ('회화',       '빅토리아회화',    21),
  ('오픽',       '브라이언오픽',    30),
  ('토플',       '비노시토플',      40),
  ('아이엘츠',   '루시 아이엘츠',   50),
  ('일본어',     '원어민회화',      60),
  ('일본어',     'JLPT',            61)
on conflict (category, name) do nothing;

-- ---------- 사물함 127칸 ----------
-- 번호는 좌상단부터 오른쪽 방향. 키 큰 칸은 맨 윗줄(row 1).
--   1층: 6x5, 1-30        (키 큰 칸 없음)
--   2층: 5x5, 31-55       (키 큰 칸 없음)
--   3층: 6x6, 56-91       (56-61 = 맨 윗줄 키 큰 칸)
--   7층: 6x6, 1-36 새번호  (1-6   = 맨 윗줄 키 큰 칸)

insert into lockers (floor, number, col, "row", is_tall)
select 1, 1 + gs, (gs % 6) + 1, (gs / 6) + 1, false
from generate_series(0, 29) gs
on conflict (floor, number) do nothing;

insert into lockers (floor, number, col, "row", is_tall)
select 2, 31 + gs, (gs % 5) + 1, (gs / 5) + 1, false
from generate_series(0, 24) gs
on conflict (floor, number) do nothing;

insert into lockers (floor, number, col, "row", is_tall)
select 3, 56 + gs, (gs % 6) + 1, (gs / 6) + 1, (gs / 6) = 0
from generate_series(0, 35) gs
on conflict (floor, number) do nothing;

insert into lockers (floor, number, col, "row", is_tall)
select 7, 1 + gs, (gs % 6) + 1, (gs / 6) + 1, (gs / 6) = 0
from generate_series(0, 35) gs
on conflict (floor, number) do nothing;
