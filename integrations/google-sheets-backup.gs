/**
 * 서면 YBM 사물함 — Supabase → Google Sheets 자동 백업
 * ------------------------------------------------------------
 * 시간 기반 트리거(예: 1시간마다)로 실행되어, Supabase의 현재 데이터를
 * 이 구글 시트의 탭들에 스냅샷으로 기록합니다. (혹시 모를 상황 대비 백업용)
 *
 * [설치]
 * 1) 구글 시트 새로 만들기 → 확장 프로그램 → Apps Script
 * 2) 이 파일 내용을 붙여넣고 저장
 * 3) 톱니바퀴(프로젝트 설정) → '스크립트 속성'에 아래 2개 추가:
 *      SUPABASE_URL          = https://xxxx.supabase.co
 *      SUPABASE_SERVICE_KEY  = (Supabase → Settings → API → service_role 'secret' 키)
 *    ※ service_role 키는 모든 권한의 비밀 키입니다. Apps Script 안에만 두고
 *      웹사이트/깃/config.js 등 외부에는 절대 넣지 마세요. (RLS를 우회해 백업하려면 필요)
 * 4) 함수 목록에서 backupToSheet 선택 → 실행 ▶ → 권한 승인(처음 1회)
 * 5) 시계 아이콘(트리거) → 트리거 추가 → 함수 backupToSheet,
 *      이벤트 소스 '시간 기반' → '시간 단위 타이머' → '1시간마다' (원하면 매일)
 */

function backupToSheet() {
  var props = PropertiesService.getScriptProperties();
  var URL = props.getProperty('SUPABASE_URL');
  var KEY = props.getProperty('SUPABASE_SERVICE_KEY');
  if (!URL || !KEY) throw new Error('스크립트 속성에 SUPABASE_URL / SUPABASE_SERVICE_KEY 를 먼저 설정하세요.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- 데이터 조회 ----
  var rentals = sb(URL, KEY,
    'rentals?select=id,student_name,phone,started_on,active,deposit_held,class_id,lockers(floor,number),classes(category,name,closing_date)&order=id.asc');
  var classes = sb(URL, KEY, 'classes?select=id,category,name,closing_date,sort&order=sort.asc');
  var logs = sb(URL, KEY, 'rental_logs?select=id,locker_id,action,detail,created_at&order=created_at.desc&limit=2000');

  // ---- 1) '현황' 탭 (사람이 보기 좋은 현재 대여 현황) ----
  var view = [['층', '번호', '학생', '전화', '반', '종강일', '마감일(종강+10)', '등록일', '상태']];
  rentals.filter(function (r) { return r.active; }).map(function (r) {
    var fl = r.lockers ? r.lockers.floor : '';
    var num = r.lockers ? r.lockers.number : '';
    var cls = r.classes ? (r.classes.category + ' ' + r.classes.name) : '';
    var closing = r.classes ? (r.classes.closing_date || '') : '';
    var deadline = closing ? addDays(closing, 10) : '';
    return [fl, num, r.student_name, r.phone || '', cls, closing, deadline, r.started_on || '', statusOf(closing)];
  }).sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); })
    .forEach(function (row) { view.push(row); });
  writeTab(ss, '현황', view);

  // ---- 2) 원자료 탭 (복구용) ----
  writeTab(ss, 'rentals', tableify(rentals, function (r) {
    return [r.id, r.lockers ? r.lockers.floor : '', r.lockers ? r.lockers.number : '',
      r.student_name, r.phone || '', r.class_id || '', r.classes ? r.classes.closing_date || '' : '',
      r.started_on || '', r.deposit_held, r.active];
  }, ['id', 'floor', 'number', 'student_name', 'phone', 'class_id', 'closing_date', 'started_on', 'deposit_held', 'active']));

  writeTab(ss, 'classes', tableify(classes, function (c) {
    return [c.id, c.category, c.name, c.closing_date || '', c.sort];
  }, ['id', 'category', 'name', 'closing_date', 'sort']));

  writeTab(ss, 'logs', tableify(logs, function (l) {
    return [l.id, l.locker_id, l.action, JSON.stringify(l.detail || {}), l.created_at];
  }, ['id', 'locker_id', 'action', 'detail', 'created_at']));

  // ---- 백업 시각 기록 ----
  var sheet = ss.getSheetByName('현황');
  sheet.getRange(1, view[0].length + 2).setValue('마지막 백업: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd HH:mm'));
}

/* ---------- Supabase REST 호출 ---------- */
function sb(URL, KEY, path) {
  var res = UrlFetchApp.fetch(URL.replace(/\/$/, '') + '/rest/v1/' + path, {
    method: 'get',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Supabase 오류 ' + code + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}

/* ---------- 시트 탭 쓰기 (전체 교체) ---------- */
function writeTab(ss, name, rows) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  if (rows && rows.length) sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(1);
}

function tableify(arr, mapFn, headers) {
  var out = [headers];
  (arr || []).forEach(function (x) { out.push(mapFn(x)); });
  return out;
}

/* ---------- 날짜/상태 ---------- */
function addDays(iso, n) {
  var p = String(iso).slice(0, 10).split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd');
}
function statusOf(closing) {
  if (!closing) return '마감 전(종강일 미정)';
  var p = String(closing).slice(0, 10).split('-');
  var dl = new Date(+p[0], +p[1] - 1, +p[2]); dl.setDate(dl.getDate() + 10); dl.setHours(23, 59, 0, 0);
  return (new Date() > dl) ? '마감됨' : '마감 전';
}
