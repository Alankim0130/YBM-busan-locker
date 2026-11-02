-- ============================================================
-- 2관 사물함(110~119)을 1층으로 이동 — 1층 1~30번 오른쪽에 세로 두 줄
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- 사물함 번호는 그대로라 사용 중인 학생·신청 기록도 함께 따라옵니다.
--
--    1  2  3  4  5  6 | 110 115
--    7  8  9 10 11 12 | 111 116
--   13 14 15 16 17 18 | 112 117
--   19 20 21 22 23 24 | 113 118
--   25 26 27 28 29 30 | 114 119
-- ============================================================
update lockers
set floor = 1,
    col   = case when number <= 114 then 7 else 8 end,
    "row" = case when number <= 114 then number - 109 else number - 114 end
where floor = 8 and number between 110 and 119;

-- 대기 중인 학생 신청도 1층으로
update requests set floor = 1 where floor = 8 and number between 110 and 119;

-- 확인: 40 이 나오면 완료 (1~30 + 110~119)
select count(*) as "1층 사물함 수" from lockers where floor = 1;
