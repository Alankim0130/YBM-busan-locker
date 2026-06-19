-- ============================================================
-- 이름 정정: 곽다희 → 김다희
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요. (한 번만 실행)
-- ============================================================

-- 1) 현재 대여중인 학생 이름 수정
update rentals
set student_name = '김다희'
where student_name = '곽다희';

-- 2) 신청 기록(rental_logs)의 이름도 함께 수정 (입금/반납/연장 등 JSON 안의 이름)
update rental_logs
set detail = jsonb_set(detail, '{student_name}', '"김다희"')
where detail->>'student_name' = '곽다희';

-- 3) (혹시 학생 신청 대기 목록에 남아 있다면)
update requests
set student_name = '김다희'
where student_name = '곽다희';
