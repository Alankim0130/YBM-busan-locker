/**
 * 서면 YBM 사물함 — Supabase → Google Sheets 자동 백업 (월별 누적 기록판)
 * ------------------------------------------------------------
 * 목적: 혹시 모를 데이터 분실에 대비해, 모든 변화를 시트에 영구 보존하고
 *       필요하면 그 순서대로 따라가며 복원할 수 있게 합니다.
 *
 * [시트 구조]
 *  ● "YYYY-MM" 월별 기록 탭  : 변화가 생길 때마다 한 줄씩 시간순으로 쌓이는
 *        누적(append-only) 기록. 한 번 쌓인 줄은 다시 지워지지 않습니다.
 *        - 등록/입금, 반납신청, 반납완료(보증금 환급), 연장, 이동, 정보수정,
 *          종강일 변경이 모두 한 줄씩 기록됩니다.
 *        - 최근 12개월만 유지하고, 더 오래된 월 탭은 자동으로 삭제합니다.
 *  ● "현황"        : 현재 사용중인 사물함 (사람이 보기 좋은 스냅샷, 매번 덮어씀)
 *  ● "초기화·고장"  : 비밀번호 초기화(1004) 필요 / 고장난 사물함 (스냅샷)
 *  ● rentals / classes / lockers / requests / notices / settings
 *                  : 복구용 원자료 전체 (스냅샷, 매번 덮어씀)
 *
 * 매 실행(시간 트리거)마다:
 *   - 스냅샷 탭들은 현재 상태로 통째로 덮어쓰고,
 *   - 월별 탭에는 새로 생긴 변화(로그)만 골라서 아래에 덧붙입니다.
 *     (이미 기록된 줄은 '키' 열로 비교해 중복 추가하지 않습니다.)
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
 *      이벤트 소스 '시간 기반' → '시간 단위 타이머' → '1시간마다' (원하면 더 자주/매일)
 *
 * ※ 예전 버전에서 만든 단일 "logs" 탭이 남아 있으면, 이제 월별 탭으로 대체되므로
 *   한 번 수동으로 지워 주셔도 됩니다(없어도 동작에는 지장 없음).
 */

var TZ = 'Asia/Seoul';
var KEEP_MONTHS = 12; // 월별 탭 보관 개월 수(이보다 오래된 월 탭은 자동 삭제)
var GRACE = 10;       // 마감일 = 종강일 + 10일

// 월별 기록 탭의 열 구성
var JOURNAL_HEADERS = ['키', '일시', '구분', '층', '번호', '학생', '생년월일', '전화',
  '반', '결제', '은행', '환급계좌', '보증금상태', '비고', '원본(detail)'];

function backupToSheet() {
  var props = PropertiesService.getScriptProperties();
  var URL = props.getProperty('SUPABASE_URL');
  var KEY = props.getProperty('SUPABASE_SERVICE_KEY');
  if (!URL || !KEY) throw new Error('스크립트 속성에 SUPABASE_URL / SUPABASE_SERVICE_KEY 를 먼저 설정하세요.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- 데이터 조회 (복구에 필요한 모든 컬럼 포함) ----
  var rentals = sb(URL, KEY,
    'rentals?select=id,locker_id,student_name,phone,birth,started_on,active,deposit_held,extended_months,bank,refund_account,pay_method,class_id,lockers(floor,number),classes(category,name,closing_date,closings)&order=id.asc&limit=100000');
  var classes = sb(URL, KEY,
    'classes?select=id,category,name,closing_date,closings,sort&order=sort.asc&limit=100000');
  var lockers = sb(URL, KEY,
    'lockers?select=id,floor,number,col,row,is_tall,broken,needs_reset&order=floor.asc,number.asc&limit=100000');
  var requests = sb(URL, KEY,
    'requests?select=id,floor,number,student_name,birth,phone,bank,refund_account,created_at&order=created_at.asc&limit=100000');
  var notices = sb(URL, KEY,
    'notices?select=id,body,author,author_email,created_at&order=created_at.asc&limit=100000');
  var settings = sb(URL, KEY,
    'app_settings?select=key,value,updated_at&order=key.asc&limit=100000');
  var logs = sb(URL, KEY,
    'rental_logs?select=id,locker_id,action,detail,created_at&order=created_at.asc&limit=100000');

  // 빠른 조회용 매핑
  var lkById = {};
  lockers.forEach(function (l) { lkById[l.id] = l; });
  var clsById = {};
  classes.forEach(function (c) { clsById[c.id] = (c.category + ' ' + c.name).trim(); });

  // ---- 1) 현황(현재 사용중) 스냅샷 ----
  writeStatusTab(ss, rentals);

  // ---- 2) 초기화·고장 스냅샷 ----
  writeAttentionTab(ss, lockers, rentals);

  // ---- 3) 복구용 원자료 스냅샷 ----
  writeTab(ss, 'rentals', rentalsTable(rentals));
  writeTab(ss, 'classes', classesTable(classes));
  writeTab(ss, 'lockers', lockersTable(lockers));
  writeTab(ss, 'requests', requestsTable(requests));
  writeTab(ss, 'notices', noticesTable(notices));
  writeTab(ss, 'settings', settingsTable(settings));

  // ---- 4) 월별 변화 기록(append-only) ----
  appendMonthlyJournal(ss, logs, lkById, clsById);

  // ---- 5) 오래된 월 탭 정리 + 탭 순서 정렬 ----
  pruneOldMonths(ss, KEEP_MONTHS);
  orderTabs(ss);

  // ---- 백업 시각 기록 ----
  stampBackupTime(ss);
}

/* ============================================================
 * 월별 변화 기록(append-only)
 * ============================================================ */
function appendMonthlyJournal(ss, logs, lkById, clsById) {
  var byMonth = {}; // "YYYY-MM" -> [ [key, ...], ... ]
  function push(month, row) { (byMonth[month] = byMonth[month] || []).push(row); }

  (logs || []).forEach(function (l) {
    var d = l.detail || {};
    var lk = lkById[l.locker_id] || {};
    var label = journalLabel(l);
    var note = journalNote(l, clsById);

    // 기본 변화 한 줄(생성 시각의 달에 기록)
    push(ymKey(l.created_at),
      journalRow(String(l.id), l.created_at, label, l.action, lk, d, note));

    // 보증금 환급 완료는 'return' 로그의 detail 업데이트로 처리되므로
    // 별도의 '반납완료(환급)' 이벤트로 환급 시각의 달에 추가 기록
    if (l.action === 'return' && d.refunded && d.refunded_at) {
      push(ymKey(d.refunded_at),
        journalRow(l.id + '-refund', d.refunded_at, '반납완료(환급)', 'refund', lk, d, '보증금 환급 완료'));
    }
  });

  Object.keys(byMonth).forEach(function (m) { appendToMonthTab(ss, m, byMonth[m]); });
}

function journalRow(key, ts, label, action, lk, d, note) {
  return [
    key,
    fmtDateTime(ts),
    label,
    lk.floor != null ? lk.floor : '',
    lk.number != null ? lk.number : '',
    d.student_name || '',
    d.birth || '',
    d.phone || '',
    d.class_label || '',
    payLabel(d.pay_method),
    d.bank || '',
    d.refund_account || '',
    depositState(d, label, action),
    note || '',
    JSON.stringify(d || {})
  ];
}

function journalLabel(l) {
  switch (l.action) {
    case 'rent': return (l.detail && l.detail.via) ? ('등록/입금(' + l.detail.via + ')') : '등록/입금';
    case 'return': return '반납신청';
    case 'extend': return '연장';
    case 'move': return '이동';
    case 'edit': return '정보수정';
    case 'class_closing': return '종강일 변경';
    default: return l.action;
  }
}

function journalNote(l, clsById) {
  var d = l.detail || {};
  switch (l.action) {
    case 'extend':
      return (d.months != null) ? ('총 ' + d.months + '개월 연장') : '';
    case 'move':
      return (d.from || '?') + ' → ' + (d.to || '?');
    case 'class_closing':
      var nm = (clsById && clsById[d.class_id]) ? clsById[d.class_id] : ('반#' + (d.class_id || '?'));
      return nm + ' / ' + (d.month || '') + ' 종강일 ' + (d.closing_date ? d.closing_date : '지움');
    default:
      return '';
  }
}

function depositState(d, label, action) {
  if (label.indexOf('환급') !== -1) return '환급완료';
  if (action === 'return') return d.refunded ? '환급완료' : '환급대기';
  if (action === 'rent') return '수령(반납 시 환급)';
  return '';
}

// 월 탭에 새 줄만 덧붙임(이미 있는 '키'는 건너뜀)
function appendToMonthTab(ss, month, rows) {
  var sheet = ss.getSheetByName(month);
  if (!sheet) {
    sheet = ss.insertSheet(month);
    sheet.getRange(1, 1, 1, JOURNAL_HEADERS.length).setValues([JOURNAL_HEADERS]);
    sheet.setFrozenRows(1);
  }
  // 기존 키 수집(중복 방지)
  var seen = {};
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) seen[String(keys[i][0])] = true;
  }
  var fresh = rows.filter(function (r) { return !seen[String(r[0])]; });
  if (!fresh.length) return;
  // 시간순(일시 문자열은 고정 형식이라 문자열 비교로 정렬 가능)
  fresh.sort(function (a, b) { return (a[1] < b[1]) ? -1 : ((a[1] > b[1]) ? 1 : 0); });
  sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, JOURNAL_HEADERS.length).setValues(fresh);
}

// 보관 기간(KEEP_MONTHS)보다 오래된 월 탭 삭제
function pruneOldMonths(ss, keep) {
  var cutoff = monthsAgoKey(keep - 1); // 현재 달 포함 최근 keep개월만 유지
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (/^\d{4}-\d{2}$/.test(name) && name < cutoff) {
      try { ss.deleteSheet(sh); } catch (e) {}
    }
  });
}

// 탭 순서: 스냅샷 탭들을 앞에, 월별 탭은 오래된 → 최신 순으로 뒤에
function orderTabs(ss) {
  var FRONT = ['현황', '초기화·고장', 'rentals', 'classes', 'lockers', 'requests', 'notices', 'settings'];
  var months = ss.getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return /^\d{4}-\d{2}$/.test(n); })
    .sort();
  var pos = 1;
  FRONT.concat(months).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos++);
  });
}

/* ============================================================
 * 스냅샷 탭들
 * ============================================================ */
// 현황: 현재 사용중인 사물함(사람이 보기 좋게)
function writeStatusTab(ss, rentals) {
  var head = ['층', '번호', '학생', '전화', '반', '종강일', '마감일(종강+10)',
    '등록일', '연장(개월)', '보증금', '결제', '상태'];
  var out = [head];
  (rentals || []).filter(function (r) { return r.active; }).map(function (r) {
    var lk = r.lockers || {};
    var cls = r.classes ? (r.classes.category + ' ' + r.classes.name) : '';
    var closing = effectiveClosing(r);
    var deadline = closing ? addDays(closing, GRACE) : '';
    return [
      lk.floor != null ? lk.floor : '',
      lk.number != null ? lk.number : '',
      r.student_name, r.phone || '', cls,
      closing || '', deadline, r.started_on || '',
      r.extended_months || 0,
      r.deposit_held ? '보유(반납 시 환급)' : '미수령',
      payLabel(r.pay_method),
      statusOf(r)
    ];
  }).sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); })
    .forEach(function (row) { out.push(row); });
  writeTab(ss, '현황', out);
}

// 초기화·고장: 조치가 필요한 사물함만
function writeAttentionTab(ss, lockers, rentals) {
  // 현재 활성 대여가 있는 사물함은 '사용중'으로 표시
  var activeLk = {};
  (rentals || []).forEach(function (r) { if (r.active && r.locker_id != null) activeLk[r.locker_id] = true; });

  var head = ['층', '번호', '상태', '비고'];
  var out = [head];
  (lockers || []).forEach(function (l) {
    var flags = [];
    if (l.needs_reset) flags.push('초기화 필요(비번 1004)');
    if (l.broken) flags.push('고장');
    if (!flags.length) return;
    out.push([l.floor, l.number, flags.join(' · '), activeLk[l.id] ? '현재 사용중' : '비어있음']);
  });
  writeTab(ss, '초기화·고장', out);
}

function rentalsTable(rentals) {
  return tableify(rentals, function (r) {
    var lk = r.lockers || {};
    return [r.id, r.locker_id, lk.floor != null ? lk.floor : '', lk.number != null ? lk.number : '',
      r.student_name, r.birth || '', r.phone || '', r.class_id || '',
      r.started_on || '', r.extended_months || 0,
      r.deposit_held, r.pay_method || '', r.bank || '', r.refund_account || '', r.active];
  }, ['id', 'locker_id', 'floor', 'number', 'student_name', 'birth', 'phone', 'class_id',
    'started_on', 'extended_months', 'deposit_held', 'pay_method', 'bank', 'refund_account', 'active']);
}

function classesTable(classes) {
  return tableify(classes, function (c) {
    return [c.id, c.category, c.name, c.closing_date || '', JSON.stringify(c.closings || {}), c.sort];
  }, ['id', 'category', 'name', 'closing_date(레거시)', 'closings(월별 종강일)', 'sort']);
}

function lockersTable(lockers) {
  return tableify(lockers, function (l) {
    return [l.id, l.floor, l.number, l.col, l['row'], l.is_tall, l.broken, l.needs_reset];
  }, ['id', 'floor', 'number', 'col', 'row', 'is_tall', 'broken', 'needs_reset']);
}

function requestsTable(requests) {
  return tableify(requests, function (q) {
    return [q.id, q.floor, q.number, q.student_name, q.birth || '', q.phone || '',
      q.bank || '', q.refund_account || '', fmtDateTime(q.created_at)];
  }, ['id', 'floor', 'number', 'student_name', 'birth', 'phone', 'bank', 'refund_account', 'created_at']);
}

function noticesTable(notices) {
  return tableify(notices, function (n) {
    return [n.id, n.body, n.author || '', n.author_email || '', fmtDateTime(n.created_at)];
  }, ['id', 'body', 'author', 'author_email', 'created_at']);
}

function settingsTable(settings) {
  return tableify(settings, function (s) {
    return [s.key, s.value || '', fmtDateTime(s.updated_at)];
  }, ['key', 'value', 'updated_at']);
}

/* ============================================================
 * Supabase REST 호출
 * ============================================================ */
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

/* ============================================================
 * 시트 유틸
 * ============================================================ */
// 전체 교체(스냅샷용)
function writeTab(ss, name, rows) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  if (rows && rows.length) sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(1);
}

function tableify(arr, mapFn, headers) {
  var out = [headers];
  (arr || []).forEach(function (x) { out.push(mapFn(x)); });
  return out;
}

function stampBackupTime(ss) {
  var sheet = ss.getSheetByName('현황');
  if (!sheet) return;
  sheet.getRange(1, 14).setValue('마지막 백업: ' +
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'));
}

/* ============================================================
 * 날짜 / 상태 / 표시
 * ============================================================ */
function parseDate(iso) {
  if (!iso) return new Date();
  var s = String(iso).replace(/(\.\d{3})\d+/, '$1'); // 마이크로초 자르기(파싱 안정화)
  var d = new Date(s);
  if (isNaN(d.getTime())) d = new Date(String(iso).slice(0, 19) + 'Z');
  return d;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  return Utilities.formatDate(parseDate(iso), TZ, 'yyyy-MM-dd HH:mm:ss');
}
function ymKey(iso) { return Utilities.formatDate(parseDate(iso), TZ, 'yyyy-MM'); }
function monthsAgoKey(n) {
  var d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return Utilities.formatDate(d, TZ, 'yyyy-MM');
}
function addDays(iso, n) {
  var p = String(iso).slice(0, 10).split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function payLabel(m) { return m === 'cash' ? '현금' : (m === 'transfer' ? '이체' : ''); }

// 등록일(+연장 개월)이 가리키는 수업 월의 종강일. 없으면 레거시 종강일 폴백.
function termKeyFor(dateISO, addMonths) {
  var d = parseDate(dateISO);
  var y = d.getFullYear(), m = d.getMonth() + 1 + (addMonths || 0);
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return y + '-' + pad(m);
}
function effectiveClosing(r) {
  var c = r.classes || {};
  var cl = c.closings || {};
  var key = termKeyFor(r.started_on, r.extended_months || 0);
  return cl[key] || c.closing_date || '';
}
// 앱과 동일한 상태 판정: 과거 등록(미연장·종강일 미설정)도 '마감됨' 처리
function statusOf(r) {
  var c = r.classes || {};
  var cl = c.closings || {};
  var termKey = termKeyFor(r.started_on, r.extended_months || 0);
  var termClosing = cl[termKey] || null; // 그 달 '직접 설정한' 종강일(레거시 제외)
  var nowKey = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  var termIsPast = r.started_on ? (termKey < nowKey) : false;
  var forcedOver = !(r.extended_months > 0) && termIsPast && !termClosing;
  if (forcedOver) return '마감됨';

  var closing = effectiveClosing(r);
  if (!closing) return '마감 전(종강일 미정)';
  var p = String(closing).slice(0, 10).split('-');
  var dl = new Date(+p[0], +p[1] - 1, +p[2]);
  dl.setDate(dl.getDate() + GRACE);
  dl.setHours(23, 59, 0, 0);
  return (new Date() > dl) ? '마감됨' : '마감 전';
}
