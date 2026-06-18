-- ============================================================
-- 사물함 127칸 시드 (schema.sql 실행 후 실행)
-- 번호는 좌상단부터 오른쪽 방향. 키 큰 칸은 맨 윗줄(row 1).
--   1층: 6x5, 1-30        (키 큰 칸 없음)
--   2층: 5x5, 31-55       (키 큰 칸 없음)
--   3층: 6x6, 56-91       (56-61 = 맨 윗줄 키 큰 칸)
--   7층: 6x6, 1-36 새번호  (1-6   = 맨 윗줄 키 큰 칸)
-- 여러 번 실행해도 (floor, number) unique 로 중복 없이 안전합니다.
-- ============================================================

-- 1층: 6 x 5 = 30칸 (1-30)
insert into lockers (floor, number, col, "row", is_tall)
select 1, 1 + gs, (gs % 6) + 1, (gs / 6) + 1, false
from generate_series(0, 29) gs
on conflict (floor, number) do nothing;

-- 2층: 5 x 5 = 25칸 (31-55)
insert into lockers (floor, number, col, "row", is_tall)
select 2, 31 + gs, (gs % 5) + 1, (gs / 5) + 1, false
from generate_series(0, 24) gs
on conflict (floor, number) do nothing;

-- 3층: 6 x 6 = 36칸 (56-91), 맨 윗줄(56-61) 키 큰 칸
insert into lockers (floor, number, col, "row", is_tall)
select 3, 56 + gs, (gs % 6) + 1, (gs / 6) + 1, (gs / 6) = 0
from generate_series(0, 35) gs
on conflict (floor, number) do nothing;

-- 7층: 6 x 6 = 36칸 (1-36 새 번호), 맨 윗줄(1-6) 키 큰 칸
insert into lockers (floor, number, col, "row", is_tall)
select 7, 1 + gs, (gs % 6) + 1, (gs / 6) + 1, (gs / 6) = 0
from generate_series(0, 35) gs
on conflict (floor, number) do nothing;
