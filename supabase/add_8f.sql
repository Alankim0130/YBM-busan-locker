-- ============================================================
-- 본관 8층 사물함 30칸 추가 (가로 6 x 세로 5, 1~30번)
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- 층 번호 8은 2관이 쓰고 있어서 본관 8층은 floor = 9 로 저장합니다.
--
--    1  2  3  4  5  6
--    7  8  9 10 11 12
--   13 14 15 16 17 18
--   19 20 21 22 23 24
--   25 26 27 28 29 30
-- ============================================================
insert into lockers (floor, number, col, "row", is_tall)
select 9, 1 + gs, (gs % 6) + 1, (gs / 6) + 1, false
from generate_series(0, 29) gs
on conflict (floor, number) do nothing;

-- 확인: 30 이 나오면 완료
select count(*) as "본관 8층 사물함 수" from lockers where floor = 9;
