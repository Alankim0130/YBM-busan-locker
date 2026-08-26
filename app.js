/* ============================================================
   서면 YBM 사물함 관리 — Supabase 연동 로직
   - 인증: Supabase Auth (이메일/비밀번호)
   - 데이터: classes / lockers / rentals / rental_logs (RLS 보호)
   - 마감일 = (학생이 듣는 반의 종강일) + 15일  → 조회 시 계산
   - 색상 3가지: 빈 공간(free) / 마감 전(rent) / 마감됨(over)
   - 멀티 PC 동기화: rentals · classes Realtime 구독
   ============================================================ */
(function () {
  "use strict";

  var GRACE = 15; // 종강일 + 15일 = 마감일
  var SOON = 7;   // 마감 7일 이내 = 임박(대시보드 강조)

  /* ---------- 설정 확인 ---------- */
  var URL = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
  function configured() {
    return URL && KEY && URL.indexOf("YOUR-") === -1 && KEY.indexOf("YOUR-") === -1;
  }
  var $ = function (id) { return document.getElementById(id); };
  if (!configured()) { $("setupView").classList.add("open"); return; }

  var sb = window.supabase.createClient(URL, KEY);

  /* ---------- 유틸 ---------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  var NOW = new Date();
  var DAY = 86400000;
  function fmtShort(d) {
    var w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
    return (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + w + ")";
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var p = String(iso).slice(0, 10).split("-");
    return p[0] + "." + p[1] + "." + p[2];
  }
  function parseDate(iso) {
    var p = String(iso).slice(0, 10).split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function todayISO() {
    return NOW.getFullYear() + "-" + pad(NOW.getMonth() + 1) + "-" + pad(NOW.getDate());
  }
  // 과거 등록일이면 그 날짜(정오 KST)로 로그 시각 지정, 오늘이면 실제 시각(null) 사용
  function rentLogTs(date) { return (date && date !== todayISO()) ? date + "T12:00:00+09:00" : null; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m];
    });
  }
  $("deadlineText").textContent = fmtShort(NOW);

  /* ---------- 실제 층 구성 ---------- */
  var FLOORS = [
    { id: 1, name: "1층", building: "본관", cols: 6, rows: 5, start: 1,   tallCount: 0 },
    { id: 2, name: "2층", building: "본관", cols: 5, rows: 5, start: 31,  tallCount: 0 },
    { id: 3, name: "3층", building: "본관", cols: 6, rows: 6, start: 56,  tallCount: 6 },
    { id: 4, name: "4층", building: "본관", cols: 3, rows: 6, start: 92,  tallCount: 0 },
    { id: 7, name: "7층", building: "본관", cols: 6, rows: 6, start: 1,   tallCount: 6 },
    // 2관 3층: 110~114 세로 한 줄 / 115~119 세로 한 줄, 가운데(2열)는 엘리베이터.
    { id: 8, name: "3층", building: "2관", cols: 3, rows: 5, start: 110, tallCount: 0,
      custom: {
        lockers: [[110,1,1],[111,1,2],[112,1,3],[113,1,4],[114,1,5],[115,3,1],[116,3,2],[117,3,3],[118,3,4],[119,3,5]],
        blocks: [{ label: "🛗", sub: "엘리베이터", col: 2, row: 1, rowSpan: 5 }]
      } }
  ];
  FLOORS.forEach(function (f) {
    if (f.custom) {
      var nums = f.custom.lockers.map(function (it) { return it[0]; });
      f.total = nums.length; f.start = Math.min.apply(null, nums); f.end = Math.max.apply(null, nums);
    } else {
      f.total = f.cols * f.rows; f.end = f.start + f.total - 1;
    }
  });

  var STATE = {
    free:   { c: "var(--free)",   label: "빈 공간", color: "#3ba776" },
    rent:   { c: "var(--rent)",   label: "마감 전", color: "#3b6fd4" },
    over:   { c: "var(--over)",   label: "마감됨",  color: "#d7503a" },
    broken: { c: "var(--broken)", label: "고장",    color: "#8a94a6" },
    reset:  { c: "var(--reset)",  label: "초기화 필요", color: "#d98324" }
  };
  function brokenAt(key) { var lk = LOCKERS[key]; return !!(lk && lk.broken); }
  function resetAt(key) { var lk = LOCKERS[key]; return !!(lk && lk.needs_reset); }

  /* ---------- 메모리 캐시 ---------- */
  var LOCKERS = {};        // "floor-number" -> { id, floor, number }
  var RENTALS = {};        // "floor-number" -> { id, name, phone, class_id, started_on, deposit_held }
  var CLASSES = [];        // [{ id, category, name, closing_date, closings:{"YYYY-MM":"YYYY-MM-DD"}, sort }]
  var CLASSES_BY_ID = {};  // id -> class
  var NOTICES = [];        // 특별공지 [{ id, body, author, author_email, created_at }]
  var REQUESTS = [];       // 학생 신청 대기
  var ME = { name: "직원", email: "" }; // 로그인한 직원
  var GUIDE = "비밀번호는 1004입니다.\n비밀번호 변경은 사물함 안쪽에 안내되어 있으니 참고 부탁드립니다."; // 이용 안내(편집 가능)

  function floorById(id) { return FLOORS.find(function (f) { return f.id === id; }); }
  function keyOf(f, n) { return f.id + "-" + n; }
  // 위치 표시용 라벨: 건물(관)을 앞에 붙임. (이름에 이미 관이 들어간 2관은 중복 방지)
  function locLabel(f) { return f ? ((f.building && f.building !== f.name) ? f.building + " " + f.name : f.name) : ""; }
  function locName(floorId) { return locLabel(floorById(floorId)); }

  /* ---------- 마감일 / 상태 ---------- */
  // 등록일(신청한 달) 기준 수업 월 키. 연장(개월)만큼 다음 수업 월로 이동.
  function termKeyFor(dateISO, addMonths) {
    var d = parseDate(dateISO);
    var y = d.getFullYear(), m = d.getMonth() + 1 + (addMonths || 0);
    while (m > 12) { m -= 12; y++; }
    while (m < 1) { m += 12; y--; }
    return y + "-" + pad(m);
  }
  function closingForKey(c, key) {
    if (!c) return null;
    var cl = c.closings || {};
    return cl[key] || c.closing_date || null; // 그 달 미설정이면 레거시 종강일 폴백
  }

  function deadlineOf(r) {
    if (!r || !r.class_id || !r.started_on) return null;
    var c = CLASSES_BY_ID[r.class_id]; if (!c) return null;
    var ext = r.extended_months || 0;
    var cl = c.closings || {};
    var d;
    // 1) 연장 후 수업월의 종강일이 '직접' 설정돼 있으면 그걸 사용(정확)
    var extClosing = cl[termKeyFor(r.started_on, ext)];
    if (extClosing) {
      d = parseDate(extClosing);
    } else {
      // 2) 없으면: 등록월 종강일(직접값 우선, 없으면 레거시) + 연장개월 → 항상 앞으로 밀림
      var base = cl[termKeyFor(r.started_on, 0)] || c.closing_date || null;
      if (!base) return null;
      d = parseDate(base);
      if (ext) d.setMonth(d.getMonth() + ext);
    }
    d.setDate(d.getDate() + GRACE);
    d.setHours(23, 59, 0, 0);
    return d;
  }
  function classNameOf(classId) { var c = CLASSES_BY_ID[classId]; return c ? c.name : ""; }
  // 해당 수업월의 '직접 설정한' 종강일(레거시 제외)
  function termClosing(r) {
    var c = CLASSES_BY_ID[r.class_id]; if (!c || !r.started_on) return null;
    var cl = c.closings || {}; return cl[termKeyFor(r.started_on, r.extended_months || 0)] || null;
  }
  // 적용 수업월이 현재 달보다 과거인가
  function termIsPast(r) {
    if (!r || !r.started_on) return false;
    return termKeyFor(r.started_on, r.extended_months || 0) < (NOW.getFullYear() + "-" + pad(NOW.getMonth() + 1));
  }
  // 연장 안 했고 + 등록 수업월이 과거 + 그 달 종강일 미설정 → 종강일 없이도 '마감' 처리
  function isForcedOver(r) { return !!(r && !(r.extended_months > 0) && termIsPast(r) && !termClosing(r)); }
  function statusOf(r) {
    if (!r) return "free";
    if (isForcedOver(r)) return "over"; // 과거 등록(미연장·종강일 미설정) → 마감
    var dl = deadlineOf(r);
    if (!dl) return "rent";          // 종강일 미입력(현재/미래 수업) → 마감 전으로 간주
    return NOW > dl ? "over" : "rent";
  }
  function ddInfo(dl) {
    if (!dl) return { days: null, label: "종강일 미입력" };
    var days = Math.ceil((dl - NOW) / DAY);
    var label = days > 0 ? "D-" + days : (days === 0 ? "D-DAY" : "마감 " + Math.abs(days) + "일 경과");
    return { days: days, label: label };
  }
  function classLabel(r) {
    if (!r || !r.class_id) return "반 미지정";
    var c = CLASSES_BY_ID[r.class_id];
    return c ? c.category + " · " + c.name : "반 미지정";
  }

  /* ---------- 연락 문구 (복사용) ---------- */
  function contactMsg(r, fid, num) {
    var f = floorById(fid); var dl = deadlineOf(r);
    var when = dl ? fmtShort(dl) : "곧 마감 예정";
    return "[서면 YBM] " + r.name + "님, " + locLabel(f) + " " + pad(num) + "번 사물함 마감일이 " + when +
      "입니다. 계속 사용하시려면 데스크로 연장 의사를 알려주세요. 감사합니다.";
  }
  function guideMsg(r, fid, num) {
    var f = floorById(fid);
    return "[서면 YBM] " + r.name + "님, " + locLabel(f) + " " + pad(num) + "번 사물함을 신청하셨습니다.\n" + GUIDE;
  }
  // 복사 형식: 이름 / 은행 / 계좌번호 (빈 항목은 제외)
  function copyAcct(name, bank, acct) { return [name, bank, acct].filter(Boolean).join(" / "); }
  // 보증금 입금 방법(이체/현금) 토글
  function payLabel(m) { return m === "cash" ? "💵 현금" : "💳 이체"; }
  function payToggleHTML(id, m) {
    var cash = m === "cash";
    return '<div class="paytoggle" id="' + id + '">' +
      '<button type="button" class="pt-opt' + (cash ? "" : " active") + '" data-m="transfer">💳 이체</button>' +
      '<button type="button" class="pt-opt' + (cash ? " active" : "") + '" data-m="cash">💵 현금</button></div>';
  }
  function bindPayToggle(id) {
    var box = $(id); if (!box) return;
    box.querySelectorAll(".pt-opt").forEach(function (b) {
      b.onclick = function () { box.querySelectorAll(".pt-opt").forEach(function (x) { x.classList.remove("active"); }); b.classList.add("active"); };
    });
  }
  function payToggleVal(id) { var box = $(id); var a = box && box.querySelector(".pt-opt.active"); return a ? a.getAttribute("data-m") : "transfer"; }
  function copyText(t) {
    function ok() { toast("문구가 복사되었습니다."); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(ok, function () { fallbackCopy(t, ok); });
    } else { fallbackCopy(t, ok); }
  }
  function fallbackCopy(t, ok) {
    var ta = document.createElement("textarea"); ta.value = t;
    ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); ok(); } catch (e) { toast("복사 실패 — 직접 복사해주세요."); }
    document.body.removeChild(ta);
  }

  /* ---------- 카운트 ---------- */
  function counts(f) {
    var used = 0, over = 0, broken = 0, reset = 0;
    for (var n = f.start; n <= f.end; n++) {
      var key = keyOf(f, n);
      if (brokenAt(key)) { broken++; continue; }
      var r = RENTALS[key];
      if (!r) { if (resetAt(key)) reset++; continue; }
      used++;
      if (statusOf(r) === "over") over++;
    }
    return { used: used, over: over, broken: broken, reset: reset, free: f.total - used - broken - reset };
  }

  /* ---------- 렌더링 ---------- */
  var currentId = 1, selectedKey = null;
  var moveSourceKey = null; // 이동 모드일 때 출발 칸
  var grid = $("grid"), drawer = $("drawer");

  // 건물(관) 접기/펼치기 상태 — 기본은 접힘, 펼치면 explicit false 저장. localStorage 유지.
  var collapsedBuildings = {};
  try { collapsedBuildings = JSON.parse(localStorage.getItem("ybm_collapsed_v1") || "{}") || {}; } catch (e) {}
  function isCollapsed(b) { return collapsedBuildings[b] !== false; } // 미설정이면 접힘
  function saveCollapsed() { try { localStorage.setItem("ybm_collapsed_v1", JSON.stringify(collapsedBuildings)); } catch (e) {} }
  function toggleBuilding(b) {
    collapsedBuildings[b] = !isCollapsed(b); // 접힘이면 펼치고(false), 펼침이면 접음(true)
    saveCollapsed();
    renderFloorList();
  }

  function renderFloorList() {
    var list = $("floorList"); list.innerHTML = "";
    // 건물별 빈칸 합계
    var bstats = {};
    FLOORS.forEach(function (f) { var c = counts(f); if (!bstats[f.building]) bstats[f.building] = { free: 0, total: 0 }; bstats[f.building].free += c.free; bstats[f.building].total += f.total; });
    var activeFloor = floorById(currentId);
    var lastBuilding = null;
    FLOORS.forEach(function (f) {
      if (f.building && f.building !== lastBuilding) {
        lastBuilding = f.building;
        var collapsed = isCollapsed(f.building);
        // 접혀 있고 현재 보고 있는 층이 이 건물이면 헤더에 "1관 - 2층" 처럼 현재 층 표시
        var showActive = collapsed && activeFloor && activeFloor.building === f.building && activeFloor.name !== f.building;
        var h = document.createElement("button");
        h.className = "floor-group" + (collapsed ? " collapsed" : "");
        h.innerHTML = '<span class="fg-caret">▾</span><span class="fg-name">' + esc(f.building) + "</span>" +
          (showActive ? '<span class="fg-active">- ' + esc(activeFloor.name) + "</span>" : "") +
          '<span class="fg-meta"><b>' + bstats[f.building].free + "</b> / " + bstats[f.building].total + " 빈칸</span>";
        (function (b) { h.onclick = function () { toggleBuilding(b); }; })(f.building);
        list.appendChild(h);
      }
      if (isCollapsed(f.building)) return; // 접힌 건물의 층 버튼은 숨김
      var c = counts(f);
      var btn = document.createElement("button");
      btn.className = "floor-btn" + (f.id === currentId ? " active" : "");
      btn.innerHTML =
        '<div class="fb-top"><span class="fname">' + f.name + "</span>" +
        '<span class="fmeta"><b>' + c.free + "</b> / " + f.total + " 빈칸</span></div>" +
        '<div class="fbar">' +
          '<span class="seg" style="flex:' + c.free + ';background:var(--free)"></span>' +
          '<span class="seg" style="flex:' + Math.max(c.used - c.over, 0) + ';background:var(--rent)"></span>' +
          '<span class="seg" style="flex:' + c.over + ';background:var(--over)"></span>' +
          '<span class="seg" style="flex:' + c.reset + ';background:var(--reset)"></span>' +
          '<span class="seg" style="flex:' + c.broken + ';background:var(--broken)"></span>' +
        "</div>";
      btn.onclick = function () { currentId = f.id; collapsedBuildings[f.building] = true; saveCollapsed(); showView("lockers"); closeDrawer(); renderAll(); };
      list.appendChild(btn);
    });
  }

  // 사물함 화면 상단의 빠른 층 선택 바 — 건물별로 한 줄씩
  function renderFloorPills() {
    var el = $("floorPills"); if (!el) return;
    el.innerHTML = "";
    var byB = {};
    var order = [];
    FLOORS.forEach(function (f) { if (!byB[f.building]) { byB[f.building] = []; order.push(f.building); } byB[f.building].push(f); });
    order.forEach(function (b) {
      var grp = document.createElement("div"); grp.className = "fp-group";
      var lab = document.createElement("span"); lab.className = "fp-bldg"; lab.textContent = b; grp.appendChild(lab);
      byB[b].forEach(function (f) { grp.appendChild(makePill(f)); });
      el.appendChild(grp);
    });
    function makePill(f) {
      var p = document.createElement("button");
      p.className = "fp" + (f.id === currentId ? " active" : "");
      p.textContent = f.name;
      p.onclick = function () { currentId = f.id; collapsedBuildings[f.building] = true; saveCollapsed(); showView("lockers"); closeDrawer(); renderAll(); };
      return p;
    }
  }

  function makeLockerCell(f, n) {
    var key = keyOf(f, n);
    var broken = brokenAt(key);
    var r = RENTALS[key];
    var s = broken ? "broken" : r ? statusOf(r) : (resetAt(key) ? "reset" : "free");
    var st = STATE[s];
    var el = document.createElement("button");
    var moveTarget = moveSourceKey && s === "free" && key !== moveSourceKey;
    el.className = "locker" + (broken ? " broken" : "") + (s === "reset" ? " reset" : "") + (key === selectedKey ? " sel" : "") + (moveTarget ? " movable" : "");
    el.style.setProperty("--c", st.c);
    el.innerHTML = '<span class="id">' + pad(n) + '</span><span class="who">' + (broken ? "고장" : s === "reset" ? "초기화 필요" : r ? esc(r.name) : "비어 있음") + '</span><span class="handle"></span>';
    (function (k, free) {
      el.onclick = function () {
        if (moveSourceKey) { if (free && k !== moveSourceKey) performMove(k); return; }
        select(k);
      };
    })(key, s === "free");
    return el;
  }

  // 모든 층 동일한 칸 크기: 가장 큰 층(6×6)이 화면을 채우는 크기. 살짝 세로형(실제 사물함 비율)
  function computeCellSize() {
    var stage = document.querySelector(".stage"); if (!stage) return;
    var w = stage.clientWidth, h = stage.clientHeight; if (w < 50 || h < 50) return;
    var cs = getComputedStyle(stage);
    var availW = w - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 38;  // 38: wall 좌우 패딩
    var availH = h - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 54;   // 54: wall 상하 패딩
    var maxCols = 1, maxRows = 1;
    FLOORS.forEach(function (f) { maxCols = Math.max(maxCols, f.cols); maxRows = Math.max(maxRows, f.rows); });
    var gap = 8;
    var cw = Math.floor((availW - gap * (maxCols - 1)) / maxCols);
    var ch = Math.floor((availH - gap * (maxRows - 1)) / maxRows);
    cw = Math.max(36, cw);
    ch = Math.max(40, ch);
    ch = Math.min(ch, Math.round(cw * 1.8));     // 너무 길쭉하지 않게(살짝 세로형까지만)
    document.documentElement.style.setProperty("--cell-w", cw + "px");
    document.documentElement.style.setProperty("--cell-h", ch + "px");
  }

  var lastGridFloor = null;
  function renderGrid() {
    var f = floorById(currentId);
    var animate = lastGridFloor !== f.id && !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
    lastGridFloor = f.id; // 층 바뀔 때만 등장 애니메이션
    grid.style.setProperty("--cols", f.cols);
    grid.style.gridAutoRows = "";
    grid.innerHTML = "";
    if (f.custom) {
      f.custom.blocks.forEach(function (b) {
        var d = document.createElement("div");
        d.className = "locker-block";
        d.style.gridColumn = String(b.col);
        d.style.gridRow = b.row + " / span " + (b.rowSpan || 1);
        d.innerHTML = '<span class="lb-ico">' + esc(b.label || "") + "</span>" + (b.sub ? '<span class="lb-sub">' + esc(b.sub) + "</span>" : "");
        grid.appendChild(d);
      });
      f.custom.lockers.forEach(function (it) {
        var el = makeLockerCell(f, it[0]);
        el.style.gridColumn = String(it[1]); el.style.gridRow = String(it[2]);
        grid.appendChild(el);
      });
    } else {
      for (var i = 0; i < f.total; i++) grid.appendChild(makeLockerCell(f, f.start + i));
    }
    if (animate) {
      var kids = grid.children;
      for (var k = 0; k < kids.length; k++) {
        kids[k].style.animation = "lockerIn .36s cubic-bezier(.22,1,.36,1) both";
        kids[k].style.animationDelay = Math.min(k * 9, 260) + "ms";
      }
    }
  }

  function renderHeader() {
    var f = floorById(currentId); var c = counts(f);
    $("floorTitle").textContent = locLabel(f) + " 사물함";
    $("floorSub").textContent = "전체 " + f.total + "칸 (" + f.cols + " × " + f.rows + ") · 사용 중 " +
      c.used + " · 빈칸 " + c.free + (c.over ? " · 마감됨 " + c.over : "") + (c.reset ? " · 초기화 필요 " + c.reset : "") + (c.broken ? " · 고장 " + c.broken : "");
  }

  function renderDashCount() {
    var n = 0;
    FLOORS.forEach(function (f) {
      for (var i = f.start; i <= f.end; i++) {
        var r = RENTALS[keyOf(f, i)]; if (!r) continue;
        var s = statusOf(r);
        if (s === "over") { n++; continue; }
        var dd = ddInfo(deadlineOf(r));
        if (dd.days !== null && dd.days <= SOON) n++;
      }
    });
    var el = $("dashCount"); el.textContent = n; el.classList.toggle("alert", n > 0);
    $("classCount").textContent = CLASSES.length;
  }

  function renderAll() {
    computeCellSize();
    renderFloorList(); renderFloorPills(); renderGrid(); renderHeader(); renderDashCount(); renderResetCount();
    if ($("resetView") && $("resetView").classList.contains("open")) renderResetList();
    if (selectedKey) renderDrawer();
  }

  function select(key) { selectedKey = key; renderGrid(); renderDrawer(); drawer.classList.add("open"); }
  function closeDrawer() { selectedKey = null; drawer.classList.remove("open"); renderGrid(); }

  /* ---------- 상세 패널 ---------- */
  function classOptionsHTML(selectedId) {
    var html = '<option value="">반 선택…</option>';
    orderedCategories().forEach(function (cat) {
      html += '<optgroup label="' + esc(cat) + '">';
      CLASSES.filter(function (c) { return c.category === cat; }).forEach(function (c) {
        html += '<option value="' + c.id + '"' + (String(c.id) === String(selectedId) ? " selected" : "") + ">" + esc(c.name) + "</option>";
      });
      html += "</optgroup>";
    });
    return html;
  }

  function renderDrawer() {
    var key = selectedKey; if (!key) return;
    var parts = key.split("-"); var fid = parseInt(parts[0], 10); var num = parseInt(parts[1], 10);
    var f = floorById(fid); var r = RENTALS[key];
    var broken = !r && brokenAt(key);
    var needsReset = !r && !broken && resetAt(key);
    var s = broken ? "broken" : needsReset ? "reset" : statusOf(r); var st = STATE[s];
    $("dId").textContent = "No. " + pad(num);
    $("dFloor").textContent = locLabel(f);
    var body = $("dBody"); var actions = $("dActions");

    if (broken) {
      body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
        '<div class="field"><label>상태</label><div class="v">이 사물함은 <b>고장</b>으로 표시되어 있어 대여할 수 없습니다. 수리가 끝나면 고장을 해제하세요.</div></div>';
      actions.innerHTML = '<div class="line"><button class="btn primary" id="fixBtn">🔧 고장 해제</button></div>';
      $("fixBtn").onclick = function () { setBroken(key, false); };
      return;
    }

    if (needsReset) {
      body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
        '<div class="field"><label>상태</label><div class="v">반납 처리된 사물함입니다. 비밀번호를 <b>1004</b>(초기 비밀번호)로 바꾼 뒤 <b>초기화 완료</b>를 누르면 새 학생이 사용할 수 있습니다. <br>(학생 화면에는 ‘사용중’으로 표시됩니다.)</div></div>';
      actions.innerHTML = '<div class="line"><button class="btn primary" id="resetDoneBtn">✅ 초기화 완료 (1004로 변경함)</button></div>';
      $("resetDoneBtn").onclick = function () { setNeedsReset(key, false); };
      return;
    }

    if (!r) {
      body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
        '<div class="field"><label>학생 이름</label><input class="namefield" id="newName" placeholder="이름 입력" /></div>' +
        '<div class="field"><label>생년월일 (6자리)</label><input class="namefield" id="newBirth" placeholder="예: 880130" inputmode="numeric" maxlength="6" /></div>' +
        '<div class="field"><label>전화번호</label><input class="namefield" id="newPhone" placeholder="010-0000-0000" inputmode="tel" /></div>' +
        '<div class="field"><label>은행 (선택)</label><input class="namefield" id="newBank" placeholder="예: 카카오뱅크" /></div>' +
        '<div class="field"><label>환급 계좌번호 (선택)</label><input class="namefield" id="newAccount" placeholder="보증금 환급받을 계좌번호" /></div>' +
        '<div class="field"><label>반 (마감일 = 종강일 + 15일)</label><select class="selfield" id="newClass">' + classOptionsHTML("") + "</select></div>" +
        '<div class="field"><label>등록일 (기본: 오늘 · 과거 기록은 날짜 변경)</label><input class="namefield" type="date" id="newDate" value="' + todayISO() + '" /></div>' +
        '<div class="field"><label>보증금 입금 방법</label>' + payToggleHTML("newPay", "transfer") + "</div>" +
        '<div class="field"><label>안내</label><div class="v">대여를 시작하면 보증금 1만원 수령으로 기록됩니다.</div></div>';
      actions.innerHTML = '<div class="line"><button class="btn primary" id="rentBtn">대여 시작 · 보증금 1만원 수령</button></div>' +
        '<div class="line"><button class="btn" id="breakBtn">🔧 고장으로 표시</button></div>';
      bindPayToggle("newPay");
      $("breakBtn").onclick = function () { setBroken(key, true); };
      $("rentBtn").onclick = function () {
        var nm = $("newName").value.trim();
        var ph = $("newPhone").value.trim();
        var bd = $("newBirth").value.trim();
        var bk = $("newBank").value.trim();
        var ac = $("newAccount").value.trim();
        var cid = $("newClass").value;
        if (!nm) { $("newName").focus(); return; }
        if (bd && !/^\d{6}$/.test(bd)) { toast("생년월일은 6자리 숫자로 입력하세요. (예: 880130)"); $("newBirth").focus(); return; }
        if (!cid) { toast("반을 선택하세요. (마감일 계산에 필요)"); $("newClass").focus(); return; }
        startRental(key, nm, ph, cid, bd, ac, bk, $("newDate").value || todayISO(), payToggleVal("newPay"));
      };
      return;
    }

    var forced = isForcedOver(r);
    var dl = forced ? null : deadlineOf(r);
    var dd = forced ? { days: -1, label: "마감됨" } : ddInfo(dl);
    var termM = r.started_on ? (+termKeyFor(r.started_on, 0).slice(5, 7)) : 0; // 등록(수업) 월
    var note = forced ? (termM + "월 수업(과거) · 종강일 미설정이라 마감 처리되었습니다. 계속 쓰려면 ‘연장하기’로 다음 달로 옮기거나, 반납·환급을 처리하세요.")
      : s === "over" ? "마감일이 지났습니다. 학생에게 연락해 연장 의사를 확인하거나 반납·보증금 환급을 처리하세요."
      : !dl ? (termM ? termM + "월 수업 종강일이 아직 입력되지 않았습니다. ‘반 관리’ 상단에서 " + termM + "월을 골라 종강일을 넣으세요." : "이 반의 종강일이 아직 입력되지 않았습니다.")
      : "마감일은 등록월(" + termM + "월 수업) 종강일 + 15일입니다. 등록일을 바꾸면 적용 종강월도 바뀝니다.";
    var dmsg = contactMsg(r, fid, num);   // 마감 안내
    var gmsg = guideMsg(r, fid, num);     // 비밀번호 이용 안내
    var deadlineContact = '<button class="btn small" id="copyDeadlineBtn">마감 안내 문구 복사</button>';
    var guideContact = '<button class="btn small" id="copyGuideBtn">안내 문구 복사</button>';
    var phoneVal = r.phone
      ? esc(r.phone) + ' <button class="btn small" id="copyPhoneBtn" style="padding:4px 9px;font-size:11px;margin-left:6px;">복사</button>'
      : "—";
    var ext = r.extended_months || 0;
    var memoTxt = snoteBody(r.name, r.birth);
    body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
      '<div class="field"><label>대여자</label><div class="v">' + esc(r.name) + "</div></div>" +
      '<div class="field"><label>생년월일</label><div class="v mono">' + (r.birth ? esc(r.birth) : "—") + "</div></div>" +
      '<div class="field"><label>전화번호</label><div class="v mono" style="display:flex;align-items:center;">' + phoneVal + "</div></div>" +
      '<div class="field"><label>은행</label><div class="v">' + (r.bank ? esc(r.bank) : "—") + "</div></div>" +
      '<div class="field"><label>환급 계좌번호</label><div class="v mono">' + (r.refund_account ? esc(r.refund_account) : "—") + "</div></div>" +
      '<div class="field"><label>반</label><div class="v">' + esc(classLabel(r)) + "</div></div>" +
      '<div class="field"><label>등록일</label><div class="v mono">' + fmtDate(r.started_on) + "</div></div>" +
      '<div class="field"><label>보증금</label><div class="v">' + (r.deposit_held ? "10,000원 수령 · 반납 시 환급" : "미수령") + ' <span class="pay-tag ' + (r.pay_method === "cash" ? "cash" : "") + '">' + payLabel(r.pay_method) + "</span></div></div>" +
      '<div class="field"><label>메모 (직원 공유)</label><div class="memo-box">' +
        (memoTxt ? '<div class="memo-txt">' + esc(memoTxt) + "</div>" : '<div class="memo-none">아직 메모가 없습니다.</div>') +
        '<button class="btn small" id="memoBtn">' + (memoTxt ? "메모 수정" : "＋ 메모 쓰기") + "</button></div></div>" +
      '<div class="field"><label>이용 안내 (비밀번호)</label><div class="contact-row">' + guideContact + '</div><div class="guide-prev">' + esc(GUIDE) + "</div></div>" +
      '<div class="field"><label>마감 안내</label><div class="contact-row">' + deadlineContact + "</div></div>" +
      '<div class="deadline-box"><div class="top"><span style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)">마감일 (' + (termM ? termM + "월 수업 " : "") + '종강 + 15일' + (ext ? " + 연장 " + ext + "개월" : "") + ')</span>' +
      '<span class="dd" style="color:' + st.color + '">' + dd.label + "</span></div>" +
      '<div class="v mono">' + (dl ? fmtShort(dl) : "—") + '</div><div class="note">' + note + "</div>" +
      '<div class="ext-row"><span>연장 <b>' + ext + '</b>개월</span><span class="ext-btns">' +
      '<button class="btn small" id="extBtn">+1개월 연장</button>' + (ext ? '<button class="btn small" id="extReset">초기화</button>' : "") +
      "</span></div></div>";
    actions.innerHTML =
      '<div class="line"><button class="btn" id="editBtn">정보 수정</button><button class="btn" id="moveBtn">이동하기</button></div>' +
      '<div class="line"><button class="btn" id="returnBtn">반납 신청 (보증금 환급 대기)</button></div>' +
      '<div class="line"><button class="btn danger" id="discardBtn">🗑 폐기 진행 (연락두절·미환급)</button></div>';
    $("editBtn").onclick = function () { renderEdit(key); };
    $("moveBtn").onclick = function () { beginMove(key); };
    $("returnBtn").onclick = function () { returnRental(key); };
    $("discardBtn").onclick = function () { discardRental(key); };
    var mb2 = $("memoBtn"); if (mb2) mb2.onclick = function () { openSNote(r.name, r.birth, function () { renderDrawer(); }); };
    var cd = $("copyDeadlineBtn"); if (cd) cd.onclick = function () { copyText(dmsg); };
    var cg = $("copyGuideBtn"); if (cg) cg.onclick = function () { copyText(gmsg); };
    var cp = $("copyPhoneBtn"); if (cp) cp.onclick = function () { copyText(r.phone || ""); };
    var eb = $("extBtn"); if (eb) eb.onclick = function () { extendRental(key, 1); };
    var er = $("extReset"); if (er) er.onclick = function () { extendRental(key, -(r.extended_months || 0)); };
  }

  function renderEdit(key) {
    var r = RENTALS[key]; if (!r) return;
    var body = $("dBody"); var actions = $("dActions");
    body.innerHTML =
      '<div class="field"><label>학생 이름</label><input class="namefield" id="edName" value="' + esc(r.name) + '" /></div>' +
      '<div class="field"><label>생년월일 (6자리)</label><input class="namefield" id="edBirth" value="' + esc(r.birth || "") + '" inputmode="numeric" maxlength="6" placeholder="예: 880130" /></div>' +
      '<div class="field"><label>전화번호</label><input class="namefield" id="edPhone" value="' + esc(r.phone || "") + '" inputmode="tel" /></div>' +
      '<div class="field"><label>은행</label><input class="namefield" id="edBank" value="' + esc(r.bank || "") + '" placeholder="예: 카카오뱅크" /></div>' +
      '<div class="field"><label>환급 계좌번호</label><input class="namefield" id="edAccount" value="' + esc(r.refund_account || "") + '" placeholder="보증금 환급받을 계좌번호" /></div>' +
      '<div class="field"><label>반</label><select class="selfield" id="edClass">' + classOptionsHTML(r.class_id) + "</select></div>" +
      '<div class="field"><label>등록일</label><input class="namefield" type="date" id="edDate" value="' + esc(r.started_on || todayISO()) + '" /></div>' +
      '<div class="field"><label>보증금 입금 방법</label>' + payToggleHTML("edPay", r.pay_method) + "</div>";
    actions.innerHTML = '<div class="line"><button class="btn primary" id="saveBtn">저장</button><button class="btn" id="cancelBtn">취소</button></div>';
    bindPayToggle("edPay");
    $("saveBtn").onclick = function () {
      var nm = $("edName").value.trim();
      var bd = $("edBirth").value.trim();
      if (!nm) { $("edName").focus(); return; }
      if (bd && !/^\d{6}$/.test(bd)) { toast("생년월일은 6자리 숫자로 입력하세요."); $("edBirth").focus(); return; }
      editRental(key, nm, $("edPhone").value.trim(), $("edClass").value || null, bd, $("edAccount").value.trim(), $("edBank").value.trim(), $("edDate").value || r.started_on, payToggleVal("edPay"));
    };
    $("cancelBtn").onclick = function () { renderDrawer(); };
  }

  /* ---------- 이동 모드 ---------- */
  function beginMove(key) {
    moveSourceKey = key;
    var parts = key.split("-");
    $("moveBannerText").textContent = locName(parseInt(parts[0], 10)) + " No." + pad(parseInt(parts[1], 10)) +
      " 대여를 옮길 빈 칸을 선택하세요. (다른 층도 가능)";
    $("moveBanner").hidden = false;
    drawer.classList.remove("open");
    renderGrid();
  }
  function cancelMove() { moveSourceKey = null; $("moveBanner").hidden = true; renderGrid(); }

  function performMove(targetKey) {
    var srcKey = moveSourceKey;
    var r = RENTALS[srcKey]; var target = LOCKERS[targetKey];
    if (!r || !target) { cancelMove(); return; }
    var src = LOCKERS[srcKey];
    busy(true);
    sb.from("rentals").update({ locker_id: target.id }).eq("id", r.id).then(function (res) {
      if (res.error) { busy(false); toast("이동 실패: " + res.error.message); return; }
      logAction(target.id, "move", { from: srcKey, to: targetKey, student_name: r.name, birth: r.birth || "", class_label: classNameOf(r.class_id), bank: r.bank || "", refund_account: r.refund_account || "", pay_method: r.pay_method || "transfer" });
      moveSourceKey = null; $("moveBanner").hidden = true;
      var tp = targetKey.split("-"); currentId = parseInt(tp[0], 10);
      // 출발 칸을 '초기화 필요'로 표시한 뒤 새로고침(그래야 즉시 반영)
      var setReset = src ? sb.from("lockers").update({ needs_reset: true }).eq("id", src.id) : Promise.resolve({});
      setReset.then(function () { busy(false); toast(r.name + " 님 → " + locName(currentId) + " No." + pad(parseInt(tp[1], 10)) + " 이동 완료 · 출발 칸은 초기화 필요"); reload().then(function () { select(targetKey); }); },
        function () { busy(false); reload().then(function () { select(targetKey); }); });
    });
  }

  /* ---------- 액션 (DB 반영 + 로그) ---------- */
  function busy(on) { document.body.style.cursor = on ? "progress" : ""; }

  function startRental(key, name, phone, classId, birth, account, bank, date, pay) {
    var lk = LOCKERS[key];
    if (!lk) { toast("사물함 정보를 찾을 수 없습니다."); return; }
    pay = pay || "transfer";
    busy(true);
    sb.from("rentals").insert({
      locker_id: lk.id, student_name: name, phone: phone || null, birth: birth || null,
      bank: bank || null, refund_account: account || null, pay_method: pay, class_id: classId ? Number(classId) : null, extended_months: 0,
      started_on: date || todayISO(), deposit_held: true, active: true
    }).then(function (res) {
      busy(false);
      if (res.error) { toast("대여 실패: " + res.error.message); return; }
      logAction(lk.id, "rent", { student_name: name, birth: birth || "", phone: phone || "", class_label: classNameOf(classId ? Number(classId) : null), bank: bank || "", refund_account: account || "", pay_method: pay }, rentLogTs(date));
      toast(name + " 님 대여 시작 · 보증금 1만원 " + (pay === "cash" ? "현금" : "이체") + " 수령");
      reload();
    });
  }

  function setBroken(key, val) {
    var lk = LOCKERS[key];
    if (!lk) { toast("사물함 정보를 찾을 수 없습니다."); return; }
    busy(true);
    sb.from("lockers").update({ broken: val }).eq("id", lk.id).then(function (res) {
      busy(false);
      if (res.error) { toast("처리 실패: " + res.error.message); return; }
      lk.broken = val;
      toast(val ? "고장으로 표시했습니다." : "고장을 해제했습니다.");
      renderAll();
      if (selectedKey === key) renderDrawer();
    });
  }

  function setNeedsReset(key, val) {
    var lk = LOCKERS[key];
    if (!lk) { toast("사물함 정보를 찾을 수 없습니다."); return; }
    busy(true);
    sb.from("lockers").update({ needs_reset: val }).eq("id", lk.id).then(function (res) {
      busy(false);
      if (res.error) { toast(/needs_reset/i.test(res.error.message || "") ? "스키마 적용 필요: schema.sql 을 실행해 주세요." : "처리 실패: " + res.error.message); return; }
      lk.needs_reset = val;
      toast(val ? "초기화 필요로 표시했습니다." : "초기화 완료 · 이제 대여할 수 있습니다.");
      renderAll();
      if (selectedKey === key) renderDrawer();
    });
  }

  function editRental(key, name, phone, classId, birth, account, bank, date, pay) {
    var r = RENTALS[key]; if (!r) return;
    pay = pay || r.pay_method || "transfer";
    var oldName = r.name, oldBirth = r.birth || "";   // 이름/생년월일이 바뀌면 기록·메모까지 따라가야 함
    busy(true);
    sb.from("rentals").update({ student_name: name, phone: phone || null, birth: birth || null, bank: bank || null, refund_account: account || null, pay_method: pay, class_id: classId ? Number(classId) : null, started_on: date || r.started_on })
      .eq("id", r.id).then(function (res) {
        busy(false);
        if (res.error) { toast("수정 실패: " + res.error.message); return; }
        logAction(LOCKERS[key] && LOCKERS[key].id, "edit", { student_name: name });
        // 저장할 때마다 신청 기록의 '입금' 로그 날짜를 등록일로 항상 맞춤
        syncRentLogDate(LOCKERS[key] && LOCKERS[key].id, date || r.started_on, {
          student_name: name, birth: birth || "", phone: phone || "",
          class_label: classNameOf(classId ? Number(classId) : null), bank: bank || "", refund_account: account || "", pay_method: pay
        });
        // 이름/생년월일을 고쳤으면 지난 신청 기록과 메모도 같은 사람으로 맞춤
        syncStudentIdentity(oldName, oldBirth, name, birth || "").then(function (n) {
          if (n) toast("지난 신청 기록 " + n + "건의 이름도 함께 수정했습니다.");
          loadSNotes().then(function () { if (selectedKey) renderDrawer(); });
        });
        toast("정보 수정 완료");
        reload();
      });
  }
  // 해당 사물함의 가장 최근 '입금' 로그 created_at 을 등록일로 맞춤(없으면 등록일로 새로 생성)
  function syncRentLogDate(lockerId, date, info) {
    if (!lockerId || !date) return;
    var ts = date + "T12:00:00+09:00";
    function done(res) {
      if (res && res.error) { toast("신청 기록 날짜 동기화 실패: " + res.error.message); return; }
      toast("신청 기록 날짜도 등록일로 맞췄습니다.");
      if ($("logsPane") && !$("logsPane").hidden) logLoad();
    }
    sb.from("rental_logs").select("id").eq("locker_id", lockerId).eq("action", "rent")
      .order("created_at", { ascending: false }).limit(1).then(function (res) {
        if (!res.error && res.data && res.data[0]) {
          sb.from("rental_logs").update({ created_at: ts }).eq("id", res.data[0].id).select().then(done);
        } else {
          // 입금 로그가 없던 기록이면 등록일로 새로 생성
          sb.from("rental_logs").insert({ locker_id: lockerId, action: "rent", detail: info || {}, created_at: ts }).then(done);
        }
      });
  }

  function extendRental(key, delta) {
    var r = RENTALS[key]; if (!r) return;
    var n = Math.max(0, (r.extended_months || 0) + delta);
    busy(true);
    sb.from("rentals").update({ extended_months: n }).eq("id", r.id).then(function (res) {
      busy(false);
      if (res.error) { toast("연장 실패: " + res.error.message); return; }
      logAction(LOCKERS[key] && LOCKERS[key].id, "extend", { student_name: r.name, birth: r.birth || "", class_label: classNameOf(r.class_id), bank: r.bank || "", refund_account: r.refund_account || "", pay_method: r.pay_method || "transfer", months: n });
      toast(delta > 0 ? "1개월 연장했습니다. (총 " + n + "개월)" : "연장을 초기화했습니다.");
      reload();
    });
  }

  function returnRental(key) {
    var r = RENTALS[key]; if (!r) return;
    if (!window.confirm(r.name + " 님의 반납 신청을 접수합니다.\n사물함은 즉시 비워지고, 보증금 환급은 ‘신청 기록’에서 완료 처리하세요.")) return;
    busy(true);
    // 사물함은 비우되(active=false) 보증금은 아직 보유(환급 대기) → 로그에 refunded:false 로 기록
    // 비밀번호 초기화(1004) 전까지 '초기화 필요' 상태로 둠
    var lk = LOCKERS[key];
    sb.from("rentals").update({ active: false }).eq("id", r.id).then(function (res) {
      if (res.error) { busy(false); toast("반납 신청 실패: " + res.error.message); return; }
      logAction(lk && lk.id, "return", { student_name: r.name, birth: r.birth || "", class_label: classNameOf(r.class_id), bank: r.bank || "", refund_account: r.refund_account || "", pay_method: r.pay_method || "transfer", refunded: false });
      // 초기화 필요 반영이 끝난 뒤 새로고침(그래야 '빈 공간'이 아닌 '초기화 필요'로 즉시 표시)
      markResetThen(lk, "반납 신청 접수 · 비밀번호를 1004로 초기화한 뒤 ‘초기화 완료’를 누르세요");
    });
  }
  // 사물함을 '초기화 필요'로 표시하고, 커밋 완료 후 새로고침
  function markResetThen(lk, okMsg) {
    var p = lk ? sb.from("lockers").update({ needs_reset: true }).eq("id", lk.id) : Promise.resolve({});
    p.then(function (r2) {
      busy(false);
      if (r2 && r2.error) toast(/needs_reset/i.test(r2.error.message || "") ? "스키마 적용 필요: schema.sql(또는 mobile_update.sql)을 실행하세요." : "초기화 필요 표시 실패: " + r2.error.message);
      else { if (lk) lk.needs_reset = true; toast(okMsg); }  // 메모리에도 즉시 반영 → realtime 지연과 무관하게 바로 '초기화 필요' 표시
      reload();
    }, function () { busy(false); reload(); });
  }

  // 연락두절 등으로 내용물 폐기 → 대여 종료(보증금 미환급) + 초기화 필요 + '폐기' 기록
  function discardRental(key) {
    var r = RENTALS[key]; if (!r) return;
    if (!window.confirm(r.name + " 님의 사물함을 폐기 처리합니다.\n\n· 연락두절 등으로 내용물을 폐기합니다.\n· 보증금은 환급하지 않습니다.\n· 사물함은 즉시 비워지고 ‘초기화 필요’ 상태가 됩니다.\n\n진행할까요?")) return;
    busy(true);
    var lk = LOCKERS[key];
    sb.from("rentals").update({ active: false }).eq("id", r.id).then(function (res) {
      if (res.error) { busy(false); toast("폐기 실패: " + res.error.message); return; }
      logAction(lk && lk.id, "discard", { student_name: r.name, birth: r.birth || "", phone: r.phone || "", class_label: classNameOf(r.class_id), bank: r.bank || "", refund_account: r.refund_account || "", pay_method: r.pay_method || "transfer" });
      markResetThen(lk, r.name + " 님 사물함 폐기 처리 · 비밀번호를 1004로 초기화 후 ‘초기화 완료’를 누르세요");
    });
  }

  function logAction(lockerId, action, detail, at) {
    if (!lockerId && action !== "class_closing") return;
    var row = { locker_id: lockerId || null, action: action, detail: detail || {} };
    if (at) row.created_at = at;   // 과거 등록일 등으로 기록 시각을 지정
    sb.from("rental_logs").insert(row)
      .then(function () {}, function () {});
  }

  /* ---------- 반 관리 ---------- */
  function orderedCategories() {
    var seen = {}; var cats = [];
    CLASSES.slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); }).forEach(function (c) {
      if (!seen[c.category]) { seen[c.category] = 1; cats.push(c.category); }
    });
    return cats;
  }

  function lastDayOf(y, m) { return new Date(y, m, 0).getDate(); }
  function addDaysFmt(iso, days) { // 'YYYY-MM-DD' + days → 'M/D'
    var d = parseDate(iso); d.setDate(d.getDate() + days);
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  var classEditMode = false;
  function openClasses() { classEditMode = false; applyClassMode(); renderClasses(); refreshCatList(); $("classView").classList.add("open"); }
  function closeClasses() { $("classView").classList.remove("open"); }
  function refreshCatList() {
    $("catList").innerHTML = orderedCategories().map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
  }
  function applyClassMode() {
    $("classEditBtn").textContent = classEditMode ? "완료" : "편집";
    $("classEditBtn").classList.toggle("primary", classEditMode);
    $("classAddRow").hidden = !classEditMode;
    $("classLead").innerHTML = classEditMode
      ? "<b>편집 모드</b> · 반 추가 · 이름 수정 · 순서 이동(↑↓) · 삭제를 할 수 있습니다."
      : "위에서 <b>수업 월</b>을 고른 뒤, 각 반의 날짜를 눌러 그 달의 종강일을 설정하세요. 마감일 = 종강일 + 15일.";
  }
  function toggleClassEdit() { classEditMode = !classEditMode; applyClassMode(); renderClasses(); }

  function classGroup(cat) {
    return CLASSES.filter(function (c) { return c.category === cat; })
      .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
  }

  function renderClasses() {
    if ($("cTermLabel")) $("cTermLabel").textContent = classTermM + "월";
    var list = $("classList"); list.innerHTML = "";
    if (!CLASSES.length) { list.innerHTML = '<div class="dash-empty">등록된 반이 없습니다. ‘편집’에서 추가하세요.</div>'; return; }
    orderedCategories().forEach(function (cat) {
      var lbl = document.createElement("div");
      lbl.className = "class-cat-label"; lbl.textContent = cat;
      list.appendChild(lbl);
      var wrap = document.createElement("div");
      wrap.className = "class-cards";
      var group = classGroup(cat);
      group.forEach(function (c, gi) {
        var card = document.createElement("div");
        card.className = "class-card";
        if (classEditMode) {
          card.innerHTML = '<input class="cc-name-edit" value="' + esc(c.name) + '" />' +
            '<button class="cc-move" data-d="-1"' + (gi === 0 ? " disabled" : "") + '>↑</button>' +
            '<button class="cc-move" data-d="1"' + (gi === group.length - 1 ? " disabled" : "") + '>↓</button>' +
            '<button class="cc-del2">삭제</button>';
          var inp = card.querySelector(".cc-name-edit");
          inp.onchange = function () { renameClass(c, inp.value.trim()); };
          inp.addEventListener("keydown", function (e) { if (e.key === "Enter") inp.blur(); });
          var mv = card.querySelectorAll(".cc-move");
          mv[0].onclick = function () { moveClass(c, -1); };
          mv[1].onclick = function () { moveClass(c, 1); };
          card.querySelector(".cc-del2").onclick = function () { deleteClass(c); };
        } else {
          var cl = c.closings || {};
          var key = termKey(); // 상단에서 선택한 수업 월
          var cur = cl[key];
          // 선택 월에 설정값이 없고, 레거시 종강일이 그 달이면 레거시 표시
          if (!cur && c.closing_date && String(c.closing_date).slice(0, 7) === key) cur = String(c.closing_date).slice(0, 10);
          var dateLabel = cur ? ((+cur.slice(5, 7)) + "월 " + (+cur.slice(8, 10)) + "일") : "날짜 선택";
          var due = cur ? "마감 " + addDaysFmt(cur, GRACE) : "";
          card.innerHTML = '<span class="cc-name">' + esc(c.name) + "</span>" +
            '<button class="cc-date' + (cur ? "" : " unset") + '">' + dateLabel + "</button>" +
            '<span class="cc-due">' + esc(due) + "</span>";
          card.querySelector(".cc-date").onclick = function () { openCalendar(c); };
        }
        wrap.appendChild(card);
      });
      list.appendChild(wrap);
    });
  }

  function allOrdered() {
    var arr = [];
    orderedCategories().forEach(function (cat) { classGroup(cat).forEach(function (c) { arr.push(c); }); });
    return arr;
  }
  function moveClass(c, dir) {
    var arr = allOrdered();
    var idx = -1;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === c.id) { idx = i; break; }
    var j = idx + dir;
    if (j < 0 || j >= arr.length || arr[j].category !== c.category) return; // 같은 카테고리 안에서만
    var tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
    var ups = [];
    arr.forEach(function (g, k) { if (g.sort !== k + 1) ups.push(sb.from("classes").update({ sort: k + 1 }).eq("id", g.id)); });
    if (!ups.length) return;
    Promise.all(ups).then(function () { reload(); });
  }
  function renameClass(c, name) {
    if (!name || name === c.name) { renderClasses(); return; }
    sb.from("classes").update({ name: name }).eq("id", c.id).then(function (res) {
      if (res.error) { toast(/duplicate|unique/i.test(res.error.message) ? "이미 있는 반 이름입니다." : "이름 변경 실패: " + res.error.message); renderClasses(); return; }
      toast("반 이름을 변경했습니다."); reload();
    });
  }

  /* ---------- 종강일 달력 ---------- */
  // 반 관리 화면 상단의 '수업 월' 선택값(전역). 달력 팝업은 이 수업월의 종강 날짜를 고름.
  var classTermY = NOW.getFullYear(), classTermM = NOW.getMonth() + 1;
  var calClassId = null, calY = 0, calM = 0; // calY/M = 종강 날짜를 고르는 달력의 표시 월(다른 달 가능)
  function termKey() { return classTermY + "-" + pad(classTermM); }
  function classTermShift(delta) {
    classTermM += delta;
    if (classTermM < 1) { classTermM = 12; classTermY--; }
    if (classTermM > 12) { classTermM = 1; classTermY++; }
    renderClasses();
  }
  function syncCalToTerm() {
    var c = CLASSES_BY_ID[calClassId]; var cl = (c && c.closings) || {};
    var v = cl[termKey()];
    if (v) { calY = +v.slice(0, 4); calM = +v.slice(5, 7); }   // 저장된 종강 날짜의 달로
    else { calY = classTermY; calM = classTermM; }             // 없으면 수업 월부터
  }
  function openCalendar(c) {
    calClassId = c.id;
    syncCalToTerm();
    renderCalendar();
    $("calView").classList.add("open");
  }
  function closeCalendar() { $("calView").classList.remove("open"); }
  function calShift(delta) {
    calM += delta;
    if (calM < 1) { calM = 12; calY--; }
    if (calM > 12) { calM = 1; calY++; }
    renderCalendar();
  }
  function renderCalendar() {
    var c = CLASSES_BY_ID[calClassId];
    var cl = (c && c.closings) || {};
    $("calCls").textContent = (c ? (c.category + " · " + c.name + " · ") : "") + classTermM + "월 수업 종강일";
    $("calTitle").textContent = calY + "년 " + calM + "월";
    // 종강 날짜 달력 좌우 버튼에 이동할 달 표시
    var pm = calM - 1 < 1 ? 12 : calM - 1;
    var nm = calM + 1 > 12 ? 1 : calM + 1;
    $("calPrev").innerHTML = "‹ " + pm + "월";
    $("calNext").innerHTML = nm + "월 ›";
    var key = termKey();
    var cur = cl[key];
    $("calSub").textContent = cur
      ? (classTermM + "월 수업 종강일: " + (+cur.slice(5, 7)) + "월 " + (+cur.slice(8, 10)) + "일 (다른 날짜로 변경 가능)")
      : (classTermM + "월 수업의 종강 날짜를 고르세요. (다음 달 날짜도 가능)");
    var first = new Date(calY, calM - 1, 1).getDay(); // 0=일
    var days = lastDayOf(calY, calM);
    var ym = calY + "-" + pad(calM);
    var sel = 0;
    if (cur && cur.slice(0, 7) === ym) sel = +cur.slice(8, 10);
    var tY = NOW.getFullYear(), tM = NOW.getMonth() + 1, tD = NOW.getDate();
    var g = $("calGrid"); g.innerHTML = "";
    for (var i = 0; i < first; i++) { var e = document.createElement("div"); e.className = "cal-cell empty"; g.appendChild(e); }
    for (var d = 1; d <= days; d++) {
      var dow = (first + d - 1) % 7;
      var cell = document.createElement("button");
      cell.className = "cal-cell" + (d === sel ? " selected" : "") +
        (calY === tY && calM === tM && d === tD ? " today" : "") +
        (dow === 0 ? " sun" : dow === 6 ? " sat" : "");
      cell.textContent = d;
      (function (dd) { cell.onclick = function () { saveClosing(calClassId, termKey(), calY + "-" + pad(calM) + "-" + pad(dd)); closeCalendar(); }; })(d);
      g.appendChild(cell);
    }
  }

  // 특정 달(ym = "YYYY-MM")의 종강일을 저장/삭제. date=null 이면 그 달만 지움.
  function saveClosing(classId, ym, date) {
    var c = CLASSES_BY_ID[classId]; if (!c) return;
    var cl = {}; var old = c.closings || {};
    for (var k in old) if (old[k]) cl[k] = old[k];
    if (date) cl[ym] = date; else delete cl[ym];
    var mLabel = (+ym.slice(5, 7)) + "월 수업";
    sb.from("classes").update({ closings: cl }).eq("id", classId).then(function (res) {
      if (res.error) { toast(/closings/i.test(res.error.message || "") ? "스키마 적용 필요: schema.sql 을 실행해 주세요." : "종강일 저장 실패: " + res.error.message); return; }
      logAction(null, "class_closing", { class_id: classId, month: ym, closing_date: date || "" });
      toast(date ? mLabel + " 종강일 저장됨" : mLabel + " 종강일 지움");
      reload();
    });
  }

  function addClass() {
    var cat = $("newClassCat").value.trim();
    var name = $("newClassName").value.trim();
    if (!cat || !name) { toast("카테고리와 반 이름을 입력하세요."); return; }
    var maxSort = CLASSES.reduce(function (m, c) { return Math.max(m, c.sort || 0); }, 0);
    sb.from("classes").insert({ category: cat, name: name, sort: maxSort + 1 }).then(function (res) {
      if (res.error) { toast(/duplicate|unique/i.test(res.error.message) ? "이미 있는 반입니다." : "추가 실패: " + res.error.message); return; }
      $("newClassName").value = "";
      toast(name + " 반 추가됨");
      reload();
    });
  }

  function deleteClass(c) {
    if (!window.confirm("‘" + c.name + "’ 반을 삭제할까요?")) return;
    sb.from("classes").delete().eq("id", c.id).then(function (res) {
      if (res.error) { toast(/foreign key|violates/i.test(res.error.message) ? "이 반을 사용하는 대여가 있어 삭제할 수 없습니다. 먼저 해당 대여의 반을 변경하세요." : "삭제 실패: " + res.error.message); return; }
      toast(c.name + " 반 삭제됨");
      reload();
    });
  }

  /* ---------- 학생 검색 ---------- */
  function openSearch() {
    $("searchInput").value = "";
    renderSearch("");
    $("searchView").classList.add("open");
    setTimeout(function () { $("searchInput").focus(); }, 40);
  }
  function closeSearch() { $("searchView").classList.remove("open"); }
  function renderSearch(q) {
    var box = $("searchResults");
    var qq = (q || "").trim();
    if (!qq) { box.innerHTML = '<div class="dash-empty">이름 또는 생년월일을 입력하세요.</div>'; return; }
    var digits = qq.replace(/\D/g, "");
    var items = [];
    Object.keys(RENTALS).forEach(function (key) {
      var r = RENTALS[key];
      var hit = (r.name && r.name.indexOf(qq) !== -1) || (digits && r.birth && String(r.birth).indexOf(digits) !== -1);
      if (!hit) return;
      var p = key.split("-");
      items.push({ key: key, fid: parseInt(p[0], 10), num: parseInt(p[1], 10), r: r });
    });
    items.sort(function (a, b) { return (a.fid - b.fid) || (a.num - b.num); });
    if (!items.length) { box.innerHTML = '<div class="dash-empty">검색 결과가 없습니다. (현재 대여 중인 학생만 검색됩니다)</div>'; return; }
    box.innerHTML = "";
    items.forEach(function (it) {
      var st = STATE[statusOf(it.r)];
      var bank = it.r.bank || "";
      var acct = it.r.refund_account || "";
      var hasAcct = bank || acct;
      var acctText = [bank, acct].filter(Boolean).join(" ") || "계좌 미입력";
      var row = document.createElement("div");
      row.className = "dash-row search-row";
      row.innerHTML = '<span class="ds-dot" style="background:' + st.color + '"></span>' +
        '<div class="sr-main">' +
          '<div class="sr-top">' +
            '<span class="ds-loc">' + locName(it.fid) + " No." + pad(it.num) + "</span>" +
            '<span class="ds-name">' + esc(it.r.name) + "</span>" +
            '<span class="ds-phone">' + (it.r.birth ? esc(it.r.birth) : "—") + "</span>" +
            '<span class="ds-dd" style="color:var(--ink-2)">' + esc(classLabel(it.r)) + "</span>" +
          "</div>" +
          '<div class="sr-acct"><span class="sr-acct-txt">💳 ' + esc(acctText) + "</span>" +
            (hasAcct ? '<button class="btn small sr-copy">복사</button>' : "") +
          "</div>" +
        "</div>";
      row.onclick = function () { currentId = it.fid; closeSearch(); showView("lockers"); renderAll(); select(it.key); };
      var cp = row.querySelector(".sr-copy");
      if (cp) cp.addEventListener("click", function (ev) { ev.stopPropagation(); copyText(copyAcct(it.r.name, bank, acct)); });
      box.appendChild(row);
    });
  }

  /* ---------- 학생 신청 대기 ---------- */
  function loadRequests() {
    var cols = "id, floor, number, student_name, birth, phone, bank, refund_account, created_at";
    function done(res) {
      if (res.error) return;
      REQUESTS = res.data || [];
      renderReqCount();
      if ($("reqView").classList.contains("open")) renderReq();
    }
    return sb.from("requests").select(cols).order("created_at", { ascending: true }).then(function (res) {
      if (res.error && /bank/i.test(res.error.message || "")) {
        return sb.from("requests").select(cols.replace(", bank", "")).order("created_at", { ascending: true }).then(done);
      }
      done(res);
    });
  }
  function renderReqCount() {
    var el = $("reqCount"); el.textContent = REQUESTS.length; el.classList.toggle("alert", REQUESTS.length > 0);
  }
  function openReq() { renderReq(); $("reqView").classList.add("open"); }
  function closeReq() { $("reqView").classList.remove("open"); }
  function reqTime(ts) { var d = new Date(ts); return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function renderReq() {
    $("reqLead").textContent = "학생이 직접 신청한 목록 · " + REQUESTS.length + "건 · 반을 선택하고 수락하세요.";
    var list = $("reqList");
    if (!REQUESTS.length) { list.innerHTML = '<div class="dash-empty">대기 중인 신청이 없습니다.</div>'; return; }
    list.innerHTML = "";
    REQUESTS.forEach(function (q) {
      var f = floorById(q.floor);
      var card = document.createElement("div"); card.className = "req-card";
      card.innerHTML = '<div class="req-top"><span class="rq-loc">' + (f ? locLabel(f) : q.floor + "층") + " No." + pad(q.number) + "</span>" +
        '<span class="rq-name">' + esc(q.student_name) + '</span><span class="rq-time">' + reqTime(q.created_at) + "</span></div>" +
        '<div class="req-info"><span>생년월일 <b>' + esc(q.birth || "-") + "</b></span><span>전화 <b>" + esc(q.phone || "-") + "</b></span><span>은행 <b>" + esc(q.bank || "-") + "</b></span><span>환급계좌 <b>" + esc(q.refund_account || "-") + "</b></span></div>" +
        '<div class="req-pay"><span class="rqp-label">보증금</span>' + payToggleHTML("rqpay-" + q.id, "transfer") + "</div>" +
        '<div class="req-act"><select class="selfield rq-class">' + classOptionsHTML("") + "</select>" +
        '<button class="btn primary rq-accept">수락</button><button class="btn rq-reject">거절</button></div>';
      card.querySelector(".rq-accept").onclick = function () { acceptReq(q, card.querySelector(".rq-class").value, payToggleVal("rqpay-" + q.id)); };
      card.querySelector(".rq-reject").onclick = function () { rejectReq(q); };
      list.appendChild(card);
      bindPayToggle("rqpay-" + q.id); // DOM 추가 후 연결(그래야 현금/이체 버튼이 눌림)
    });
  }
  function acceptReq(q, classId, pay) {
    if (!classId) { toast("반을 선택하세요."); return; }
    var lk = LOCKERS[q.floor + "-" + q.number];
    if (!lk) { toast("사물함 정보를 찾을 수 없습니다."); return; }
    pay = pay || "transfer";
    busy(true);
    sb.from("rentals").insert({
      locker_id: lk.id, student_name: q.student_name, phone: q.phone || null, birth: q.birth || null,
      bank: q.bank || null, refund_account: q.refund_account || null, pay_method: pay, class_id: Number(classId), extended_months: 0,
      started_on: todayISO(), deposit_held: true, active: true
    }).then(function (res) {
      if (res.error) { busy(false); toast(/duplicate|unique/i.test(res.error.message) ? "이미 사용 중인 사물함입니다." : "수락 실패: " + res.error.message); return; }
      logAction(lk.id, "rent", { student_name: q.student_name, birth: q.birth || "", phone: q.phone || "", class_label: classNameOf(Number(classId)), bank: q.bank || "", refund_account: q.refund_account || "", pay_method: pay, via: "학생신청" });
      sb.from("requests").delete().eq("id", q.id).then(function () {
        busy(false); toast(q.student_name + " 님 신청 수락 · 대여 시작"); loadRequests(); reload();
      });
    });
  }
  function rejectReq(q) {
    if (!window.confirm(q.student_name + " 님의 신청을 거절(삭제)할까요?")) return;
    sb.from("requests").delete().eq("id", q.id).then(function (res) {
      if (res.error) { toast("거절 실패: " + res.error.message); return; }
      toast("신청을 거절했습니다."); loadRequests();
    });
  }

  /* ---------- 갱신 마감 대시보드 ---------- */
  var dashMonth = "all";   // 등록 월 필터 — "all" 또는 "YYYY-MM"(등록일 없으면 "none")

  // 등록 월(사물함을 신청한 달) — 연장과 무관하게 최초 등록일 기준
  function regMonthKey(r) { return (r && r.started_on) ? termKeyFor(r.started_on, 0) : "none"; }
  function monthLabel(key) {
    var p = String(key).split("-"), y = +p[0], m = +p[1];
    return (y === NOW.getFullYear()) ? (m + "월") : (String(y).slice(2) + "년 " + m + "월");
  }
  function monthChipLabel(k) { return k === "none" ? "등록일 미상" : monthLabel(k); }
  function monthRowLabel(k) { return k === "none" ? "등록일 미상" : monthLabel(k) + " 등록"; }

  function openDash() { renderDash(); $("dashView").classList.add("open"); }
  function closeDash() { $("dashView").classList.remove("open"); }
  function renderDashIfOpen() { if ($("dashView").classList.contains("open")) renderDash(); }

  /* ---------- 초기화 필요 목록 ---------- */
  function resetItems() {
    var items = [];
    FLOORS.forEach(function (f) {
      for (var n = f.start; n <= f.end; n++) {
        var key = keyOf(f, n);
        if (resetAt(key) && !RENTALS[key]) items.push({ key: key, f: f, n: n });
      }
    });
    return items;
  }
  function renderResetCount() {
    var el = $("resetCount"); if (!el) return;
    var n = resetItems().length;
    el.textContent = n; el.classList.toggle("alert", n > 0);
  }
  function openResetList() { renderResetList(); $("resetView").classList.add("open"); }
  function closeResetList() { $("resetView").classList.remove("open"); }
  function renderResetList() {
    var items = resetItems();
    $("resetLead").textContent = "비밀번호를 1004로 바꿔야 하는 사물함 · " + items.length + "건";
    var list = $("resetList");
    if (!items.length) { list.innerHTML = '<div class="dash-empty">초기화가 필요한 사물함이 없습니다.</div>'; return; }
    list.innerHTML = "";
    items.forEach(function (it) {
      var st = STATE.reset;
      var row = document.createElement("div");
      row.className = "dash-row";
      row.innerHTML = '<span class="ds-dot" style="background:' + st.color + '"></span>' +
        '<span class="ds-loc">' + locLabel(it.f) + " No." + pad(it.n) + "</span>" +
        '<span class="ds-name" style="flex:1;color:var(--ink-2)">비밀번호 1004로 초기화</span>' +
        '<button class="btn small ds-rdone">초기화 완료</button>';
      row.onclick = function () { currentId = it.f.id; closeResetList(); showView("lockers"); renderAll(); select(it.key); };
      var btn = row.querySelector(".ds-rdone");
      btn.addEventListener("click", function (ev) { ev.stopPropagation(); setNeedsReset(it.key, false); renderResetList(); });
      list.appendChild(row);
    });
  }

  // 마감됨 / 마감 임박 사물함 목록(필터 적용 전)
  function dashItems() {
    var items = [];
    FLOORS.forEach(function (f) {
      for (var n = f.start; n <= f.end; n++) {
        var key = keyOf(f, n); var r = RENTALS[key]; if (!r) continue;
        var s = statusOf(r); var dd = ddInfo(deadlineOf(r));
        if (s === "over" || (dd.days !== null && dd.days <= SOON)) {
          items.push({ key: key, f: f, n: n, r: r, s: s, days: dd.days, label: dd.label, mkey: regMonthKey(r) });
        }
      }
    });
    items.sort(function (a, b) {
      var da = a.days === null ? 9999 : a.days, db = b.days === null ? 9999 : b.days;
      return da - db; // 마감 임박/경과 순
    });
    return items;
  }

  // 등록 월 필터 칩 — 목록에 실제로 있는 달만 표시
  function renderDashFilter(all) {
    var box = $("dashFilter"); if (!box) return;
    var keys = [], cnt = {};
    all.forEach(function (it) {
      if (cnt[it.mkey] === undefined) { cnt[it.mkey] = 0; keys.push(it.mkey); }
      cnt[it.mkey]++;
    });
    keys.sort();   // 오래된 달 → 최근 달
    if (dashMonth !== "all" && cnt[dashMonth] === undefined) dashMonth = "all";  // 고른 달이 비면 전체로
    box.hidden = !all.length;
    var html = '<button class="df-chip' + (dashMonth === "all" ? " active" : "") + '" data-m="all">전체 <b>' + all.length + "</b></button>";
    keys.forEach(function (k) {
      html += '<button class="df-chip' + (dashMonth === k ? " active" : "") + '" data-m="' + esc(k) + '">' +
        esc(monthChipLabel(k)) + " <b>" + cnt[k] + "</b></button>";
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll(".df-chip"), function (b) {
      b.addEventListener("click", function () { dashMonth = b.getAttribute("data-m"); renderDash(); });
    });
  }

  function renderDash() {
    var all = dashItems();
    renderDashFilter(all);
    var items = dashMonth === "all" ? all : all.filter(function (it) { return it.mkey === dashMonth; });
    $("dashLead").textContent = "마감됨 또는 마감 " + SOON + "일 이내 · " + all.length + "건 (연락이 필요한 사물함)" +
      (dashMonth === "all" ? "" : " · " + monthChipLabel(dashMonth) + " 등록 " + items.length + "건 보는 중");
    var list = $("dashList");
    if (!items.length) {
      list.innerHTML = '<div class="dash-empty">' +
        (all.length ? esc(monthChipLabel(dashMonth)) + "에 등록한 사물함이 없습니다."
                    : "연락이 필요한 사물함이 없습니다. 모두 정상입니다.") + "</div>";
      return;
    }
    list.innerHTML = "";
    items.forEach(function (it) {
      var st = STATE[it.s];
      var planned = !!it.r.contact_planned;
      var row = document.createElement("div");
      row.className = "dash-row dl-row";   // dl-row: PC에서 열 맞춤(그리드) 적용
      row.innerHTML = '<span class="ds-dot" style="background:' + st.color + '"></span>' +
        '<span class="ds-loc">' + locLabel(it.f) + " No." + pad(it.n) + "</span>" +
        '<span class="ds-name">' + esc(it.r.name) + "</span>" +
        '<span class="ds-month">' + esc(monthRowLabel(it.mkey)) + "</span>" +
        '<span class="ds-phone">' + (it.r.phone ? esc(it.r.phone) : "전화 미입력") + "</span>" +
        '<span class="ds-dd" style="color:' + st.color + '">' + it.label + "</span>" +
        '<button class="btn small ds-sms">복사</button>' +
        '<label class="ds-plan' + (planned ? " planned" : "") + '">' +
          '<input type="checkbox"' + (planned ? " checked" : "") + '><span>연락예정</span></label>';
      row.onclick = function () { currentId = it.f.id; closeDash(); showView("lockers"); renderAll(); select(it.key); };
      var cbtn = row.querySelector(".ds-sms");
      cbtn.addEventListener("click", function (ev) { ev.stopPropagation(); copyText(contactMsg(it.r, it.f.id, it.n)); });
      var plan = row.querySelector(".ds-plan");
      plan.addEventListener("click", function (ev) { ev.stopPropagation(); });   // 체크만 하고 사물함 화면으로 넘어가지 않게
      plan.querySelector("input").addEventListener("change", function (ev) {
        var on = ev.target.checked;
        plan.classList.toggle("planned", on);
        setContactPlanned(it.r, on, ev.target, plan);
      });
      list.appendChild(row);
    });
  }

  // '연락예정' 체크 저장 — 직원 모두가 공유(실패하면 체크를 원래대로 되돌림)
  function setContactPlanned(r, val, box, lab) {
    var prev = !!r.contact_planned;
    r.contact_planned = val;   // 응답을 기다리지 않고 화면에 먼저 반영
    function revert(msg) {
      r.contact_planned = prev;
      if (box) box.checked = prev;
      if (lab) lab.classList.toggle("planned", prev);
      toast(msg);
    }
    sb.from("rentals").update({ contact_planned: val }).eq("id", r.id).then(function (res) {
      if (res.error) {
        revert(/contact_planned/i.test(res.error.message || "")
          ? "스키마 적용 필요: mobile_update.sql 을 실행해 주세요."
          : "연락예정 저장 실패: " + res.error.message);
      }
    }, function () { revert("연락예정 저장 실패 — 잠시 후 다시 시도해 주세요."); });
  }

  /* ---------- 데이터 로드 ---------- */
  function loadClasses() {
    var cols = "id, category, name, closing_date, closings, sort";
    function build(res) {
      if (res.error) throw res.error;
      CLASSES = res.data || []; CLASSES_BY_ID = {};
      // 레거시 closing_date 는 그 수업월에 closings 값이 없을 때만 폴백(closingForKey). 자동 병합하지 않음.
      CLASSES.forEach(function (c) { if (!c.closings) c.closings = {}; CLASSES_BY_ID[c.id] = c; });
    }
    return sb.from("classes").select(cols).order("sort", { ascending: true }).then(function (res) {
      // closings 컬럼이 아직 없으면(스키마 미적용) 빼고 재시도
      if (res.error && /closings/i.test(res.error.message || "")) {
        return sb.from("classes").select("id, category, name, closing_date, sort").order("sort", { ascending: true }).then(build);
      }
      return build(res);
    });
  }
  function loadLockers() {
    function build(res) {
      if (res.error) throw res.error;
      LOCKERS = {};
      (res.data || []).forEach(function (l) { LOCKERS[l.floor + "-" + l.number] = l; });
    }
    return sb.from("lockers").select("id, floor, number, broken, needs_reset").then(function (res) {
      // needs_reset 컬럼이 아직 없으면(스키마 미적용) 빼고 재시도
      if (res.error && /needs_reset/i.test(res.error.message || "")) {
        return sb.from("lockers").select("id, floor, number, broken").then(build);
      }
      return build(res);
    });
  }
  function loadRentals() {
    var cols = "id, student_name, phone, birth, class_id, extended_months, bank, refund_account, pay_method, contact_planned, started_on, deposit_held, lockers(floor, number)";
    var safeCols = "id, student_name, phone, birth, class_id, extended_months, refund_account, started_on, deposit_held, lockers(floor, number)";
    function build(res) {
      if (res.error) throw res.error;
      RENTALS = {};
      (res.data || []).forEach(function (row) {
        if (!row.lockers) return;
        RENTALS[row.lockers.floor + "-" + row.lockers.number] = {
          id: row.id, name: row.student_name, phone: row.phone, birth: row.birth, class_id: row.class_id,
          extended_months: row.extended_months || 0, bank: row.bank, refund_account: row.refund_account,
          pay_method: row.pay_method || "transfer", contact_planned: !!row.contact_planned,
          started_on: row.started_on, deposit_held: row.deposit_held
        };
      });
    }
    return sb.from("rentals").select(cols).eq("active", true).then(function (res) {
      // bank/pay_method/contact_planned 컬럼이 아직 없으면(스키마 미적용) 빼고 재시도해 앱이 죽지 않게 함
      if (res.error && /bank|pay_method|contact_planned/i.test(res.error.message || "")) {
        return sb.from("rentals").select(safeCols).eq("active", true).then(build);
      }
      return build(res);
    });
  }
  function reload() {
    // lockers(초기화 필요/고장 등)도 함께 다시 읽어야 함 — realtime 이벤트가 지연/유실돼도 상태가 정확히 반영됨
    return Promise.all([loadLockers(), loadClasses(), loadRentals()]).then(function () {
      renderAll(); renderDashIfOpen(); if ($("classView").classList.contains("open")) renderClasses();
    }).catch(function (e) { toast("데이터 로드 실패: " + (e.message || e)); });
  }

  /* ---------- 특별공지 ---------- */
  function displayName(session) {
    var u = session && session.user; if (!u) return "직원";
    var m = u.user_metadata || {};
    var nm = m.name || m.full_name || m.display_name || (u.email ? u.email.split("@")[0] : "직원");
    return m.title ? (nm + " " + m.title) : nm;
  }
  function fmtNoticeTime(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function loadNotices() {
    return sb.from("notices").select("id, body, author, author_email, created_at")
      .order("created_at", { ascending: false }).then(function (res) {
        if (res.error) return;
        NOTICES = res.data || []; renderNotices();
      });
  }
  /* 한 줄 회전 표시 */
  var noticeIdx = 0, noticeRotTimer = null;
  function renderCurNotice() {
    var cur = $("noticeCur");
    if (!NOTICES.length) { cur.innerHTML = '<span class="nc-empty">등록된 공지사항이 없습니다.</span>'; return; }
    if (noticeIdx >= NOTICES.length) noticeIdx = 0;
    var n = NOTICES[noticeIdx];
    cur.innerHTML = '<div class="nc"><span class="nc-text">' + esc(n.body) + '</span>' +
      '<span class="nc-by">' + esc(n.author || "직원") + " · " + fmtNoticeTime(n.created_at) + "</span></div>";
  }
  function stopNoticeRot() { if (noticeRotTimer) { clearInterval(noticeRotTimer); noticeRotTimer = null; } }
  function startNoticeRot() {
    stopNoticeRot();
    if (NOTICES.length > 1) {
      noticeRotTimer = setInterval(function () {
        noticeIdx = (noticeIdx + 1) % NOTICES.length; renderCurNotice();
      }, 5000);
    }
  }
  function renderNotices() {
    if (noticeIdx >= NOTICES.length) noticeIdx = 0;
    renderCurNotice();
    var more = $("noticeMoreBtn");
    if (NOTICES.length) { more.hidden = false; more.textContent = "자세히 보기 (" + NOTICES.length + ")"; }
    else more.hidden = true;
    startNoticeRot();
    if ($("noticeAllView").classList.contains("open")) renderNoticeAll();
  }
  function renderNoticeAll() {
    $("noticeAllLead").textContent = "전체 " + NOTICES.length + "건";
    var list = $("noticeAllList");
    if (!NOTICES.length) { list.innerHTML = '<div class="notice-empty">등록된 공지사항이 없습니다.</div>'; return; }
    list.innerHTML = "";
    NOTICES.forEach(function (n) {
      var el = document.createElement("div"); el.className = "notice";
      el.innerHTML = '<div class="ntxt">' + esc(n.body) + "</div>" +
        '<div class="nmeta"><span class="nwho">' + esc(n.author || "직원") + '</span><span class="ntime">' + fmtNoticeTime(n.created_at) + "</span></div>" +
        '<button class="ndel" title="삭제">✕</button>';
      el.querySelector(".ndel").onclick = function () { deleteNotice(n); };
      list.appendChild(el);
    });
  }
  function openNoticeAll() { renderNoticeAll(); $("noticeAllView").classList.add("open"); }
  function closeNoticeAll() { $("noticeAllView").classList.remove("open"); }
  function openNotice() {
    $("noticeAuthor").textContent = ME.name; $("noticeBody").value = ""; $("noticeErr").textContent = "";
    $("noticeView").classList.add("open");
    setTimeout(function () { $("noticeBody").focus(); }, 40);
  }
  function closeNotice() { $("noticeView").classList.remove("open"); }
  function postNotice() {
    var body = $("noticeBody").value.trim();
    if (!body) { $("noticeErr").textContent = "내용을 입력하세요."; return; }
    var btn = $("noticePost"); btn.disabled = true; btn.textContent = "등록 중…";
    sb.from("notices").insert({ body: body, author: ME.name, author_email: ME.email }).then(function (res) {
      btn.disabled = false; btn.textContent = "등록";
      if (res.error) { $("noticeErr").textContent = "등록 실패: " + res.error.message; return; }
      closeNotice(); toast("공지사항을 등록했습니다."); loadNotices();
    });
  }
  function deleteNotice(n) {
    if (!window.confirm("이 공지를 삭제할까요?\n\n" + n.body)) return;
    sb.from("notices").delete().eq("id", n.id).then(function (res) {
      if (res.error) { toast("삭제 실패: " + res.error.message); return; }
      toast("공지를 삭제했습니다."); loadNotices();
    });
  }

  /* ---------- 학생 개인별 메모 (직원 공유) ----------
     이름 + 생년월일 로 한 사람을 식별. 반납 후 다시 신청해도 메모는 유지됨. */
  var SNOTES = {};   // "이름|생년월일" -> { id, student_name, birth, body, updated_by, updated_at }
  var SNOTE_OK = true;   // 테이블 미생성 시 false (메모 기능만 조용히 비활성)
  function snoteKey(name, birth) { return String(name == null ? "" : name).trim() + "|" + String(birth == null ? "" : birth).trim(); }
  function snoteOf(name, birth) { return SNOTES[snoteKey(name, birth)] || null; }
  function snoteBody(name, birth) { var n = snoteOf(name, birth); return n && n.body ? n.body : ""; }
  function loadSNotes() {
    return sb.from("student_notes").select("id, student_name, birth, body, updated_by, updated_at").limit(5000)
      .then(function (res) {
        if (res.error) { SNOTE_OK = false; return; }
        SNOTE_OK = true; SNOTES = {};
        (res.data || []).forEach(function (n) { SNOTES[snoteKey(n.student_name, n.birth)] = n; });
      }, function () { SNOTE_OK = false; });
  }
  // 메모 편집 창
  var snoteCtx = null;   // { name, birth, after }
  function openSNote(name, birth, after) {
    if (!SNOTE_OK) { toast("스키마 적용 필요: mobile_update.sql 을 실행해 주세요."); return; }
    var n = snoteOf(name, birth);
    snoteCtx = { name: name, birth: birth, after: after };
    $("snoteWho").textContent = (name || "-") + (birth ? " · " + birth : "") + " · 직원 모두에게 공유됩니다";
    $("snoteBody").value = (n && n.body) || "";
    $("snoteMeta").textContent = (n && n.updated_by)
      ? "마지막 수정 " + esc(n.updated_by) + (n.updated_at ? " · " + logYmd(n.updated_at).replace(/-/g, ".") : "")
      : "";
    $("snoteView").classList.add("open");
    setTimeout(function () { $("snoteBody").focus(); }, 40);
  }
  function closeSNote() { $("snoteView").classList.remove("open"); snoteCtx = null; }
  function saveSNote() {
    if (!snoteCtx) return;
    var ctx = snoteCtx, body = $("snoteBody").value.trim();
    var btn = $("snoteSave"); btn.disabled = true; btn.textContent = "저장 중…";
    sb.from("student_notes").upsert({
      student_name: String(ctx.name || "").trim(), birth: String(ctx.birth || "").trim(),
      body: body, updated_by: (ME && ME.name) || "직원", updated_at: new Date().toISOString()
    }, { onConflict: "student_name,birth" }).select().then(function (res) {
      btn.disabled = false; btn.textContent = "저장";
      if (res.error) { toast("메모 저장 실패: " + res.error.message); return; }
      var row = (res.data || [])[0];
      if (row) SNOTES[snoteKey(row.student_name, row.birth)] = row;
      closeSNote();
      toast(body ? "메모를 저장했습니다." : "메모를 비웠습니다.");
      if (ctx.after) ctx.after();
    });
  }

  /* ---------- 이용 안내(비밀번호) 설정 ---------- */
  function loadSettings() {
    return sb.from("app_settings").select("key,value").eq("key", "password_guide").then(function (res) {
      if (res.error) return;
      var row = (res.data || [])[0];
      if (row && row.value) GUIDE = row.value;
    });
  }
  function openGuide() { $("guideBody").value = GUIDE; $("guideErr").textContent = ""; $("guideView").classList.add("open"); setTimeout(function () { $("guideBody").focus(); }, 40); }
  function closeGuide() { $("guideView").classList.remove("open"); }
  function saveGuide() {
    var v = $("guideBody").value.trim();
    if (!v) { $("guideErr").textContent = "내용을 입력하세요."; return; }
    var btn = $("guideSave"); btn.disabled = true; btn.textContent = "저장 중…";
    sb.from("app_settings").upsert({ key: "password_guide", value: v, updated_at: new Date().toISOString() }).then(function (res) {
      btn.disabled = false; btn.textContent = "저장";
      if (res.error) { $("guideErr").textContent = "저장 실패: " + res.error.message; return; }
      GUIDE = v; closeGuide(); toast("이용 안내 문구를 저장했습니다."); if (selectedKey) renderDrawer();
    });
  }

  /* ---------- 신청 기록 (같은 화면 내 전환) ---------- */
  function showView(v) {
    var logs = v === "logs";
    $("logsPane").hidden = !logs;
    $("stageTop").hidden = logs;
    $("stageWrap").hidden = logs;
    if (logs) { closeDrawer(); if (moveSourceKey) cancelMove(); $("moveBanner").hidden = true; }
  }
  var logEdit = false, LOGROWS = [], logY = 0, logM = 0, logFilter = "all", logSel = {};
  var LOGFILTERS = [["all", "전체"], ["rent", "입금"], ["return", "반납"], ["extend", "연장"], ["move", "이동"], ["discard", "폐기"]];
  var logFmtD = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  var logFmtT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });
  function logYmd(ts) { return logFmtD.format(new Date(ts)); }
  function logHm(ts) { return logFmtT.format(new Date(ts)); }
  function logLocker(l) { if (!l.lockers) return "—"; var f = floorById(l.lockers.floor); return (f ? locLabel(f) : l.lockers.floor + "층") + " " + l.lockers.number + "번"; }
  var LOGMETA = { rent: { t: "입금", c: "in" }, extend: { t: "연장", c: "ext" }, move: { t: "이동", c: "mv" }, discard: { t: "폐기", c: "discard" } };

  function openLogs() {
    showView("logs");
    logSel = {};
    var tp = logYmd(Date.now()).split("-"); logY = +tp[0]; logM = +tp[1];
    $("logTableArea").innerHTML = '<div class="log-empty">불러오는 중…</div>';
    logCleanup().then(logLoad);
  }
  function logCleanup() { var d = new Date(); d.setFullYear(d.getFullYear() - 1); return sb.from("rental_logs").delete().lt("created_at", d.toISOString()).then(function(){}, function(){}); }
  function logLoad() {
    sb.from("rental_logs").select("id, action, detail, created_at, lockers(floor, number)")
      .in("action", ["rent", "return", "extend", "move", "discard"]).order("created_at", { ascending: false }).limit(8000)
      .then(function (res) {
        if (res.error) { $("logTableArea").innerHTML = '<div class="log-empty">기록을 불러오지 못했습니다: ' + esc(res.error.message) + "</div>"; return; }
        LOGROWS = res.data || []; logRender();
      });
  }
  function logMonthCounts(year) { var c = {}; LOGROWS.forEach(function (l) { var p = logYmd(l.created_at).split("-"); if (+p[0] === year) { var m = +p[1]; c[m] = (c[m] || 0) + 1; } }); return c; }
  function logBadge(l) { if (l.action === "return") return (l.detail && l.detail.refunded) ? { t: "반납완료", c: "out" } : { t: "반납신청", c: "pending" }; return LOGMETA[l.action] || { t: l.action, c: "mv" }; }
  function logRender() {
    $("logYmYear").textContent = logY + "년";
    var counts = logMonthCounts(logY);
    var totalY = Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0);
    $("logLead").textContent = "한국시간 · " + logY + "년 " + totalY + "건";
    var mb = $("logMonthBar"); mb.innerHTML = "";
    for (var m = 1; m <= 12; m++) {
      var has = counts[m] || 0;
      var b = document.createElement("button");
      b.className = "mbtn" + (m === logM ? " active" : "") + (has ? " has" : "");
      b.innerHTML = m + "월" + (has ? '<span class="mb-cnt">' + has + "</span>" : "");
      (function (mm) { b.onclick = function () { logM = mm; logRender(); }; })(m);
      mb.appendChild(b);
    }
    renderLogFilter();
    logRenderTable();
  }
  function renderLogFilter() {
    var bar = $("logFilter"); if (!bar) return; bar.innerHTML = "";
    LOGFILTERS.forEach(function (d) {
      var b = document.createElement("button");
      b.className = "lf-chip" + (logFilter === d[0] ? " active" : "");
      b.textContent = d[1];
      (function (k) { b.onclick = function () { logFilter = k; logRender(); }; })(d[0]);
      bar.appendChild(b);
    });
  }
  // 메모 칸 — 내용이 있으면 앞부분만 미리보기, 없으면 '＋ 메모'
  function memoCell(l) {
    var d = l.detail || {};
    var b = snoteBody(d.student_name, d.birth);
    var prev = b.replace(/\s+/g, " ").trim();
    if (prev.length > 14) prev = prev.slice(0, 14) + "…";
    return '<button class="memo-btn' + (b ? " has" : "") + '" data-id="' + l.id + '" title="' + esc(b || "메모 쓰기") + '">' +
      (b ? esc(prev) : "＋ 메모") + "</button>";
  }
  function logRenderTable() {
    var area = $("logTableArea");
    var rows = LOGROWS.filter(function (l) { var p = logYmd(l.created_at).split("-"); return +p[0] === logY && +p[1] === logM; });
    if (logFilter !== "all") rows = rows.filter(function (l) { return l.action === logFilter; });
    if (!rows.length) { area.innerHTML = '<div class="log-empty">' + logY + "년 " + logM + "월 " + (logFilter !== "all" ? "‘" + (LOGFILTERS.filter(function (x) { return x[0] === logFilter; })[0] || ["", ""])[1] + "’ " : "") + "기록이 없습니다.</div>"; return; }
    var html = '<div class="log-scroll"><table class="log-table"><thead><tr>' +
      '<th class="c-check"><input type="checkbox" id="logCheckAll" title="이 화면 전체 선택"></th>' +
      "<th>구분</th><th>이름</th><th>생년월일</th><th>반</th><th>메모</th><th>은행</th><th>계좌번호</th><th>사물함</th><th>날짜</th><th>시간</th><th>처리</th>" +
      (logEdit ? "<th>삭제</th>" : "") + "</tr></thead><tbody>";
    rows.forEach(function (l) {
      var d = l.detail || {}; var meta = logBadge(l);
      var proc = "";
      if (l.action === "return") proc = d.refunded ? '<span class="proc-done">✓ 환급완료</span>' : '<button class="log-done" data-id="' + l.id + '">반납완료 처리</button>';
      else if (l.action === "rent") proc = d.paid_confirmed ? '<span class="proc-done">✓ 입금확인</span>' : '<button class="log-confirm" data-id="' + l.id + '">입금확인</button>';
      // 편집 모드에서는 은행·계좌를 눌러 바로 수정, 평소에는 읽기 전용 + 복사
      var bankCell = logEdit
        ? '<button class="acct-btn' + (d.bank ? "" : " empty") + '" data-id="' + l.id + '" title="은행·계좌 수정">' + esc(d.bank || "＋ 입력") + "</button>"
        : esc(d.bank || "—");
      var acct = logEdit
        ? '<button class="acct-btn' + (d.refund_account ? "" : " empty") + '" data-id="' + l.id + '" title="은행·계좌 수정">' + esc(d.refund_account || "＋ 입력") + "</button>"
        : ((d.bank || d.refund_account)
            ? '<span class="la-txt">' + esc(d.refund_account || "—") + '</span><button class="la-copy" data-id="' + l.id + '">복사</button>'
            : '<span class="la-none">—</span>');
      html += "<tr>" +
        '<td class="c-check"><input type="checkbox" class="log-check" data-id="' + l.id + '"' + (logSel[l.id] ? " checked" : "") + "></td>" +
        '<td><span class="log-badge ' + meta.c + '">' + meta.t + "</span></td>" +
        '<td class="c-name"><button class="name-btn" data-id="' + l.id + '" title="이름 수정">' + esc(d.student_name || "—") + "</button></td>" +
        '<td class="c-mono">' + esc(d.birth || "") + "</td>" +
        "<td>" + esc(d.class_label || "") + "</td>" +
        '<td class="c-memo">' + memoCell(l) + "</td>" +
        "<td>" + bankCell + "</td>" +
        '<td class="c-acct">' + acct + "</td>" +
        '<td class="c-locker">' + esc(logLocker(l)) + "</td>" +
        '<td class="c-mono">' + logYmd(l.created_at).replace(/-/g, ".") + "</td>" +
        '<td class="c-mono">' + logHm(l.created_at) + "</td>" +
        "<td>" + proc + "</td>" +
        (logEdit ? '<td><button class="log-del" data-id="' + l.id + '">삭제</button></td>' : "") +
        "</tr>";
    });
    html += "</tbody></table></div>";
    area.innerHTML = html;
    var byId = {}; rows.forEach(function (l) { byId[l.id] = l; });
    area.querySelectorAll(".log-done").forEach(function (b) { b.onclick = function () { logMarkRefunded(byId[b.getAttribute("data-id")]); }; });
    area.querySelectorAll(".log-confirm").forEach(function (b) { b.onclick = function () { logMarkPaid(byId[b.getAttribute("data-id")]); }; });
    area.querySelectorAll(".la-copy").forEach(function (b) { b.onclick = function () { var l = byId[b.getAttribute("data-id")]; var d = l.detail || {}; copyText(copyAcct(d.student_name || "", d.bank || "", d.refund_account || "")); }; });
    area.querySelectorAll(".name-btn").forEach(function (b) { b.onclick = function () { logEditName(byId[b.getAttribute("data-id")]); }; });
    area.querySelectorAll(".memo-btn").forEach(function (b) {
      b.onclick = function () {
        var l = byId[b.getAttribute("data-id")], d = l.detail || {};
        openSNote(d.student_name || "", d.birth || "", function () { logRenderTable(); if (selectedKey) renderDrawer(); });
      };
    });
    if (logEdit) area.querySelectorAll(".log-del").forEach(function (b) { b.onclick = function () { logRemove(byId[b.getAttribute("data-id")]); }; });
    area.querySelectorAll(".acct-btn").forEach(function (b) { b.onclick = function () { openAcct(byId[b.getAttribute("data-id")]); }; });
    var checks = area.querySelectorAll(".log-check");
    checks.forEach(function (cb) { cb.onchange = function () { var id = cb.getAttribute("data-id"); if (cb.checked) logSel[id] = true; else delete logSel[id]; syncCheckAll(); }; });
    var all = $("logCheckAll");
    if (all) all.onchange = function () { checks.forEach(function (cb) { cb.checked = all.checked; var id = cb.getAttribute("data-id"); if (all.checked) logSel[id] = true; else delete logSel[id]; }); };
    syncCheckAll();
    function syncCheckAll() { if (!all) return; var arr = Array.prototype.slice.call(checks); all.checked = arr.length > 0 && arr.every(function (c) { return c.checked; }); }
  }
  // 선택 항목을 [입금]/[반납] 포맷으로 복사
  function logMd(ts) { var p = logYmd(ts).split("-"); return (+p[1]) + "/" + (+p[2]); }
  function logBuildReport() {
    var sel = LOGROWS.filter(function (l) { return logSel[l.id]; });
    if (!sel.length) { toast("보고할 항목을 체크로 선택하세요."); return; }
    function byDate(a, b) { return a.created_at < b.created_at ? -1 : (a.created_at > b.created_at ? 1 : 0); }
    var rent = sel.filter(function (l) { return l.action === "rent"; }).sort(byDate);
    var ret = sel.filter(function (l) { return l.action === "return"; }).sort(byDate);
    var out = [];
    if (rent.length) {
      out.push("[입금 " + rent.length + "건]");
      rent.forEach(function (l) { var d = l.detail || {}; out.push("□ " + logMd(l.created_at) + " " + (d.student_name || "") + " " + (d.birth || "")); });
    }
    if (ret.length) {
      if (out.length) out.push("");
      out.push("[반납 " + ret.length + "건]");
      ret.forEach(function (l) {
        var d = l.detail || {};
        out.push("□ " + logMd(l.created_at) + " " + (d.student_name || "") + " " + (d.birth || ""));
        var acct = [d.bank, d.refund_account].filter(Boolean).join(" ");
        if (acct) out.push(acct);
      });
    }
    if (!out.length) { toast("입금·반납 항목을 선택하세요. (연장·이동·폐기는 보고에서 제외)"); return; }
    var text = out.join("\n");
    function ok() { toast("입금 " + rent.length + " · 반납 " + ret.length + "건 복사됨"); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text, ok); });
    else fallbackCopy(text, ok);
  }
  /* ---------- 학생 이름 수정 (연동: 기록 + 사물함 + 신청대기 + 메모) ---------- */
  // 이름/생년월일이 바뀌면 신청 기록(detail jsonb)과 메모 키까지 함께 맞춘다.
  // rental_logs 는 jsonb 안이라 일괄 update 가 안 되므로 건별로 수정.
  function syncStudentIdentity(oldName, oldBirth, newName, newBirth) {
    oldName = String(oldName == null ? "" : oldName).trim();
    oldBirth = String(oldBirth == null ? "" : oldBirth).trim();
    newName = String(newName == null ? "" : newName).trim();
    newBirth = String(newBirth == null ? "" : newBirth).trim();
    if (!oldName || (oldName === newName && oldBirth === newBirth)) return Promise.resolve(0);
    return sb.from("rental_logs").select("id, detail")
      .filter("detail->>student_name", "eq", oldName).limit(8000)
      .then(function (res) {
        var jobs = [];
        (res.error ? [] : (res.data || [])).forEach(function (x) {
          var dd = x.detail || {};
          if (String(dd.birth == null ? "" : dd.birth).trim() !== oldBirth) return;   // 동명이인 보호
          var nd = Object.assign({}, dd, { student_name: newName, birth: newBirth });
          jobs.push(sb.from("rental_logs").update({ detail: nd }).eq("id", x.id));
        });
        var n = SNOTES[snoteKey(oldName, oldBirth)];
        if (n && n.id) jobs.push(sb.from("student_notes").update({ student_name: newName, birth: newBirth }).eq("id", n.id));
        var logCount = jobs.length - (n && n.id ? 1 : 0);
        return Promise.all(jobs).then(function () { return logCount; });
      });
  }

  function logEditName(l) {
    var d = l.detail || {};
    var oldName = String(d.student_name || "").trim();
    var birth = String(d.birth || "").trim();
    if (!oldName) { toast("이름이 없는 기록입니다."); return; }
    var input = window.prompt("학생 이름을 수정합니다.\n생년월일: " + (birth || "미입력") + "\n\n※ 같은 학생의 다른 기록·사물함·메모까지 함께 바뀝니다.", oldName);
    if (input === null) return;
    var newName = String(input).trim();
    if (!newName) { toast("이름을 입력하세요."); return; }
    if (newName === oldName) return;
    renameStudent(oldName, birth, newName);
  }

  function renameStudent(oldName, birth, newName) {
    // 영향 범위 미리 집계(확인창용)
    var logs = LOGROWS.filter(function (x) {
      var dd = x.detail || {};
      return String(dd.student_name || "").trim() === oldName && String(dd.birth || "").trim() === birth;
    });
    var lockers = Object.keys(RENTALS).filter(function (k) {
      var r = RENTALS[k];
      return String(r.name || "").trim() === oldName && String(r.birth || "").trim() === birth;
    });
    var hasNote = !!SNOTES[snoteKey(oldName, birth)];
    if (!window.confirm(
      "‘" + oldName + "’ → ‘" + newName + "’ 으로 바꿉니다.\n" +
      (birth ? "생년월일 " + birth + " 인 학생만 바뀝니다.\n" : "※ 생년월일이 없어, 이름이 같은 기록이 모두 바뀝니다.\n") +
      "\n· 신청 기록 " + logs.length + "건\n· 사용 중인 사물함 " + lockers.length + "건\n· 메모 " + (hasNote ? 1 : 0) + "건\n\n계속할까요?")) return;
    busy(true);
    // 대여(과거 포함) + 신청 대기는 컬럼이라 한 번에 수정
    var rq = sb.from("rentals").update({ student_name: newName }).eq("student_name", oldName);
    if (birth) rq = rq.eq("birth", birth);
    var qq = sb.from("requests").update({ student_name: newName }).eq("student_name", oldName);
    if (birth) qq = qq.eq("birth", birth);
    Promise.all([rq, qq]).then(function (rs) {
      var err = rs.filter(function (r) { return r && r.error; })[0];
      if (err) { busy(false); toast("이름 수정 실패: " + err.error.message); return; }
      return syncStudentIdentity(oldName, birth, newName, birth).then(function (n) {
        busy(false);
        toast("‘" + newName + "’ 으로 수정했습니다 · 신청 기록 " + n + "건 포함");
        loadSNotes().then(logLoad);
        reload();
      });
    }, function () { busy(false); toast("이름 수정 실패"); });
  }

  /* ---------- 은행 · 환급 계좌 수정 (연동: 기록 + 사물함 + 신청대기) ---------- */
  var acctCtx = null;   // { name, birth }
  function openAcct(l) {
    var d = l.detail || {};
    var name = String(d.student_name || "").trim();
    if (!name) { toast("이름이 없는 기록은 계좌를 수정할 수 없습니다."); return; }
    acctCtx = { name: name, birth: String(d.birth || "").trim() };
    $("acctWho").textContent = name + (acctCtx.birth ? " · " + acctCtx.birth : "") + " · 보증금 환급 계좌";
    $("acctBank").value = d.bank || "";
    $("acctNo").value = d.refund_account || "";
    $("acctErr").textContent = "";
    $("acctView").classList.add("open");
    setTimeout(function () { $("acctBank").focus(); }, 40);
  }
  function closeAcct() { $("acctView").classList.remove("open"); acctCtx = null; }
  function saveAcct() {
    if (!acctCtx) return;
    var name = acctCtx.name, birth = acctCtx.birth;
    var bank = $("acctBank").value.trim(), no = $("acctNo").value.trim();
    // 영향 범위 집계
    var logs = LOGROWS.filter(function (x) {
      var dd = x.detail || {};
      return String(dd.student_name || "").trim() === name && String(dd.birth || "").trim() === birth;
    });
    var lockers = Object.keys(RENTALS).filter(function (k) {
      var r = RENTALS[k];
      return String(r.name || "").trim() === name && String(r.birth || "").trim() === birth;
    });
    if (!window.confirm(
      name + " 님의 환급 계좌를 바꿉니다.\n\n· 은행: " + (bank || "(비움)") + "\n· 계좌번호: " + (no || "(비움)") + "\n" +
      (birth ? "" : "\n※ 생년월일이 없어, 이름이 같은 기록이 모두 바뀝니다.\n") +
      "\n· 신청 기록 " + logs.length + "건\n· 사용 중인 사물함 " + lockers.length + "건\n\n계속할까요?")) return;
    var btn = $("acctSave"); btn.disabled = true; btn.textContent = "저장 중…";
    var patch = { bank: bank || null, refund_account: no || null };
    var rq = sb.from("rentals").update(patch).eq("student_name", name);
    if (birth) rq = rq.eq("birth", birth);
    var qq = sb.from("requests").update(patch).eq("student_name", name);
    if (birth) qq = qq.eq("birth", birth);
    Promise.all([rq, qq]).then(function (rs) {
      var err = rs.filter(function (r) { return r && r.error; })[0];
      if (err) { btn.disabled = false; btn.textContent = "저장"; $("acctErr").textContent = "저장 실패: " + err.error.message; return; }
      // 신청 기록은 detail(jsonb) 안이라 건별 수정 — 보고서·복사 문구도 이 값을 씀
      return sb.from("rental_logs").select("id, detail").filter("detail->>student_name", "eq", name).limit(8000)
        .then(function (res) {
          var jobs = [];
          (res.error ? [] : (res.data || [])).forEach(function (x) {
            var dd = x.detail || {};
            if (String(dd.birth == null ? "" : dd.birth).trim() !== birth) return;   // 동명이인 보호
            jobs.push(sb.from("rental_logs").update({ detail: Object.assign({}, dd, { bank: bank, refund_account: no }) }).eq("id", x.id));
          });
          return Promise.all(jobs).then(function () { return jobs.length; });
        })
        .then(function (n) {
          btn.disabled = false; btn.textContent = "저장";
          closeAcct();
          toast("계좌를 수정했습니다 · 신청 기록 " + n + "건 포함");
          logLoad(); reload();
        });
    }, function () { btn.disabled = false; btn.textContent = "저장"; $("acctErr").textContent = "저장에 실패했습니다. 잠시 후 다시 시도해 주세요."; });
  }

  function logMarkRefunded(l) {
    if (!l) return; var d = l.detail || {};
    if (!window.confirm("보증금 반납(환급)을 완료 처리할까요?\n\n" + (d.student_name || "") + " / " + logLocker(l) + "\n환급계좌: " + (d.refund_account || "-") + "\n\n※ 계좌로 보증금을 입금한 뒤 체크하세요.")) return;
    var nd = {}; for (var k in d) nd[k] = d[k]; nd.refunded = true; nd.refunded_at = new Date().toISOString();
    sb.from("rental_logs").update({ detail: nd }).eq("id", l.id).then(function (res) {
      if (res.error) { toast("처리 실패: " + res.error.message); return; }
      l.detail = nd; logRender();
    });
  }
  function logMarkPaid(l) {
    if (!l) return; var d = l.detail || {};
    if (!window.confirm("입금(보증금 수령)을 확인 처리할까요?\n\n" + (d.student_name || "") + " / " + logLocker(l) + " / " + (d.pay_method === "cash" ? "현금" : "이체"))) return;
    var nd = {}; for (var k in d) nd[k] = d[k]; nd.paid_confirmed = true; nd.paid_confirmed_at = new Date().toISOString();
    sb.from("rental_logs").update({ detail: nd }).eq("id", l.id).then(function (res) {
      if (res.error) { toast("처리 실패: " + res.error.message); return; }
      l.detail = nd; logRender();
    });
  }
  function logRemove(l) {
    if (!l) return; var d = l.detail || {}; var meta = logBadge(l);
    if (!window.confirm("이 기록을 삭제할까요?\n\n" + meta.t + " / " + (d.student_name || "") + " / " + logLocker(l) + " / " + logYmd(l.created_at))) return;
    sb.from("rental_logs").delete().eq("id", l.id).then(function (res) {
      if (res.error) { toast("삭제 실패: " + res.error.message); return; }
      LOGROWS = LOGROWS.filter(function (x) { return x.id !== l.id; }); logRender();
    });
  }

  /* ---------- Realtime ---------- */
  var channel = null;
  function subscribeRealtime() {
    if (channel) return;
    channel = sb.channel("ybm-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "rentals" }, function () { reload(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "classes" }, function () { reload(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "notices" }, function () { loadNotices(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "student_notes" }, function () {
        loadSNotes().then(function () {
          if (selectedKey) renderDrawer();
          if ($("logsPane") && !$("logsPane").hidden) logRenderTable();
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, function () { loadSettings().then(function () { if (selectedKey) renderDrawer(); }); })
      .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, function (payload) { if (payload && payload.eventType === "INSERT") toast("📥 새 사물함 신청이 들어왔습니다."); loadRequests(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "lockers" }, function () { loadLockers().then(function () { renderAll(); if (selectedKey) renderDrawer(); }); })
      .subscribe();
  }
  function unsubscribeRealtime() { if (channel) { sb.removeChannel(channel); channel = null; } }

  /* ---------- 토스트 ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2800);
  }

  /* ---------- 인증 게이트 ---------- */
  var entered = false;
  function showLogin() { $("userBox").hidden = true; $("noticeBar").hidden = true; $("loginView").classList.add("open"); }
  function enterApp(session) {
    $("loginView").classList.remove("open");
    ME = { name: displayName(session), email: (session && session.user && session.user.email) || "" };
    var ub = $("userEmail"); ub.textContent = ME.name; ub.title = ME.email;
    $("userBox").hidden = false;
    $("noticeBar").hidden = false;
    if (entered) return;
    entered = true;
    busy(true);
    loadLockers().then(function () { return Promise.all([loadClasses(), loadRentals(), loadNotices(), loadSettings(), loadRequests(), loadSNotes()]); }).then(function () {
      busy(false); renderAll();
    }).catch(function (e) {
      busy(false);
      toast("초기 로드 실패: " + (e.message || e) + " — 스키마/시드 실행 여부를 확인하세요.");
    });
    subscribeRealtime();
  }

  /* ---------- 이벤트 바인딩 ---------- */
  $("closeBtn").onclick = closeDrawer;
  $("dashBtn").onclick = openDash;
  $("dashClose").onclick = closeDash;
  $("resetBtn").onclick = openResetList;
  $("resetClose").onclick = closeResetList;
  $("classBtn").onclick = openClasses;
  $("classClose").onclick = closeClasses;
  $("classEditBtn").onclick = toggleClassEdit;
  $("logBtn").onclick = openLogs;
  $("logBack").onclick = function () { showView("lockers"); };
  $("logReportBtn").onclick = logBuildReport;
  $("logEditBtn").onclick = function () { logEdit = !logEdit; $("logEditBtn").textContent = logEdit ? "완료" : "편집"; $("logEditBtn").classList.toggle("primary", logEdit); logRender(); };
  $("logPrevY").onclick = function () { logY--; logRender(); };
  $("logNextY").onclick = function () { logY++; logRender(); };
  $("searchBtn").onclick = openSearch;
  $("searchClose").onclick = closeSearch;
  $("reqBtn").onclick = openReq;
  $("reqClose").onclick = closeReq;

  // 사물함 격자 영역의 빈 공간을 클릭하면 상세 패널 닫기
  // (패널 #drawer 는 stage 의 형제라 패널 내부 클릭은 여기로 전파되지 않음 → 안전)
  var stageEl = $("stageWrap");
  if (stageEl) stageEl.addEventListener("click", function (e) {
    if (!drawer.classList.contains("open")) return;   // 열려 있을 때만
    if (e.target.closest(".locker")) return;          // 칸 클릭은 선택/전환 유지
    if (moveSourceKey) return;                         // 이동 모드 중엔 간섭 안 함
    closeDrawer();
  });
  var rzT; window.addEventListener("resize", function () { clearTimeout(rzT); rzT = setTimeout(computeCellSize, 120); });
  $("searchInput").addEventListener("input", function (e) { renderSearch(e.target.value); });
  $("addClassBtn").onclick = addClass;
  $("newClassName").addEventListener("keydown", function (e) { if (e.key === "Enter") addClass(); });
  $("moveCancel").onclick = cancelMove;
  $("calPrev").onclick = function () { calShift(-1); };
  $("calNext").onclick = function () { calShift(1); };
  $("calClose").onclick = closeCalendar;
  $("calClear").onclick = function () { if (calClassId) { saveClosing(calClassId, termKey(), null); closeCalendar(); } };
  $("cTermPrev").onclick = function () { classTermShift(-1); };
  $("cTermNext").onclick = function () { classTermShift(1); };
  $("guideBtn").onclick = openGuide;
  $("guideSave").onclick = saveGuide;
  $("guideCancel").onclick = closeGuide;
  $("snoteSave").onclick = saveSNote;
  $("snoteCancel").onclick = closeSNote;
  $("snoteView").onclick = function (e) { if (e.target === $("snoteView")) closeSNote(); };
  $("acctSave").onclick = saveAcct;
  $("acctCancel").onclick = closeAcct;
  $("acctView").onclick = function (e) { if (e.target === $("acctView")) closeAcct(); };
  $("noticeAddBtn").onclick = openNotice;
  $("noticeMoreBtn").onclick = openNoticeAll;
  $("noticeAllClose").onclick = closeNoticeAll;
  $("noticeAllAdd").onclick = function () { closeNoticeAll(); openNotice(); };
  $("noticePost").onclick = postNotice;
  $("noticeCancel").onclick = closeNotice;
  $("noticeBody").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postNotice(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("calView").classList.contains("open")) closeCalendar();
    else if ($("reqView").classList.contains("open")) closeReq();
    else if ($("searchView").classList.contains("open")) closeSearch();
    else if ($("guideView").classList.contains("open")) closeGuide();
    else if ($("noticeView").classList.contains("open")) closeNotice();
    else if ($("noticeAllView").classList.contains("open")) closeNoticeAll();
    else if ($("classView").classList.contains("open")) closeClasses();
    else if ($("dashView").classList.contains("open")) closeDash();
    else if ($("resetView").classList.contains("open")) closeResetList();
    else if (moveSourceKey) cancelMove();
    else closeDrawer();
  });

  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("loginEmail").value.trim();
    var pw = $("loginPw").value;
    var btn = $("loginBtn"); var err = $("loginErr");
    err.textContent = ""; btn.disabled = true; btn.textContent = "로그인 중…";
    sb.auth.signInWithPassword({ email: email, password: pw }).then(function (res) {
      btn.disabled = false; btn.textContent = "로그인";
      if (res.error) { err.textContent = "로그인 실패: " + res.error.message; return; }
      $("loginPw").value = "";
    });
  });
  $("logoutBtn").onclick = function () { sb.auth.signOut(); };

  /* ---------- 시작 ---------- */
  sb.auth.getSession().then(function (res) {
    var session = res.data && res.data.session;
    if (session) enterApp(session); else showLogin();
  });
  sb.auth.onAuthStateChange(function (event, session) {
    if (session) { enterApp(session); }
    else { entered = false; unsubscribeRealtime(); stopNoticeRot(); showView("lockers"); closeDrawer(); closeDash(); closeResetList(); closeClasses(); closeCalendar(); closeNotice(); closeNoticeAll(); closeGuide(); closeSearch(); closeReq(); cancelMove(); NOTICES = []; REQUESTS = []; noticeIdx = 0; showLogin(); }
  });
})();
