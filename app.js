/* ============================================================
   서면 YBM 사물함 관리 — Supabase 연동 로직
   - 인증: Supabase Auth (이메일/비밀번호)
   - 데이터: classes / lockers / rentals / rental_logs (RLS 보호)
   - 마감일 = (학생이 듣는 반의 종강일) + 10일  → 조회 시 계산
   - 색상 3가지: 빈 공간(free) / 마감 전(rent) / 마감됨(over)
   - 멀티 PC 동기화: rentals · classes Realtime 구독
   ============================================================ */
(function () {
  "use strict";

  var GRACE = 10; // 종강일 + 10일 = 마감일
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
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m];
    });
  }
  $("deadlineText").textContent = fmtShort(NOW);

  /* ---------- 실제 층 구성 ---------- */
  var FLOORS = [
    { id: 1, name: "1층", cols: 6, rows: 5, start: 1,  tallCount: 0 },
    { id: 2, name: "2층", cols: 5, rows: 5, start: 31, tallCount: 0 },
    { id: 3, name: "3층", cols: 6, rows: 6, start: 56, tallCount: 6 },
    { id: 7, name: "7층", cols: 6, rows: 6, start: 1,  tallCount: 6 }
  ];
  FLOORS.forEach(function (f) { f.total = f.cols * f.rows; f.end = f.start + f.total - 1; });

  var STATE = {
    free: { c: "var(--free)", label: "빈 공간",  color: "#3ba776" },
    rent: { c: "var(--rent)", label: "마감 전",  color: "#3b6fd4" },
    over: { c: "var(--over)", label: "마감됨",   color: "#d7503a" }
  };

  /* ---------- 메모리 캐시 ---------- */
  var LOCKERS = {};        // "floor-number" -> { id, floor, number }
  var RENTALS = {};        // "floor-number" -> { id, name, phone, class_id, started_on, deposit_held }
  var CLASSES = [];        // [{ id, category, name, closing_date, sort }]
  var CLASSES_BY_ID = {};  // id -> class
  var NOTICES = [];        // 특별공지 [{ id, body, author, author_email, created_at }]
  var ME = { name: "직원", email: "" }; // 로그인한 직원
  var GUIDE = "비밀번호는 1004입니다.\n비밀번호 변경은 사물함 안쪽에 안내되어 있으니 참고 부탁드립니다."; // 이용 안내(편집 가능)

  function floorById(id) { return FLOORS.find(function (f) { return f.id === id; }); }
  function keyOf(f, n) { return f.id + "-" + n; }

  /* ---------- 마감일 / 상태 ---------- */
  function deadlineOf(r) {
    if (!r || !r.class_id) return null;
    var c = CLASSES_BY_ID[r.class_id];
    if (!c || !c.closing_date) return null;
    var d = parseDate(c.closing_date);
    if (r.extended_months) d.setMonth(d.getMonth() + r.extended_months); // 연장(개월)
    d.setDate(d.getDate() + GRACE);
    d.setHours(23, 59, 0, 0);
    return d;
  }
  function classNameOf(classId) { var c = CLASSES_BY_ID[classId]; return c ? c.name : ""; }
  function statusOf(r) {
    if (!r) return "free";
    var dl = deadlineOf(r);
    if (!dl) return "rent";          // 종강일 미입력 → 마감 전으로 간주
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
    return "[서면 YBM] " + r.name + "님, " + f.name + " " + pad(num) + "번 사물함 마감일이 " + when +
      "입니다. 계속 사용하시려면 데스크로 연장 의사를 알려주세요. 감사합니다.";
  }
  function guideMsg(r, fid, num) {
    var f = floorById(fid);
    return "[서면 YBM] " + r.name + "님, " + f.name + " " + pad(num) + "번 사물함을 신청하셨습니다.\n" + GUIDE;
  }
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
    var used = 0, over = 0;
    for (var n = f.start; n <= f.end; n++) {
      var s = statusOf(RENTALS[keyOf(f, n)]);
      if (s !== "free") used++;
      if (s === "over") over++;
    }
    return { used: used, over: over, free: f.total - used };
  }

  /* ---------- 렌더링 ---------- */
  var currentId = 1, selectedKey = null;
  var moveSourceKey = null; // 이동 모드일 때 출발 칸
  var grid = $("grid"), drawer = $("drawer");

  function renderFloorList() {
    var list = $("floorList"); list.innerHTML = "";
    FLOORS.forEach(function (f) {
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
        "</div>";
      btn.onclick = function () { currentId = f.id; closeDrawer(); renderAll(); };
      list.appendChild(btn);
    });
  }

  function renderGrid() {
    var f = floorById(currentId);
    grid.style.setProperty("--cols", f.cols); // 칸 크기는 CSS가 결정(전 칸 동일 크기·반응형)
    grid.innerHTML = "";
    for (var i = 0; i < f.total; i++) {
      var n = f.start + i;
      var key = keyOf(f, n);
      var r = RENTALS[key]; var s = statusOf(r); var st = STATE[s];
      var el = document.createElement("button");
      var moveTarget = moveSourceKey && s === "free" && key !== moveSourceKey;
      el.className = "locker" + (key === selectedKey ? " sel" : "") + (moveTarget ? " movable" : "");
      el.style.setProperty("--c", st.c);
      el.innerHTML = '<span class="id">' + pad(n) + '</span><span class="who">' + (r ? esc(r.name) : "비어 있음") + '</span><span class="handle"></span>';
      (function (k, free) {
        el.onclick = function () {
          if (moveSourceKey) { if (free && k !== moveSourceKey) performMove(k); return; }
          select(k);
        };
      })(key, s === "free");
      grid.appendChild(el);
    }
  }

  function renderHeader() {
    var f = floorById(currentId); var c = counts(f);
    $("floorTitle").textContent = f.name + " 사물함";
    $("floorSub").textContent = "전체 " + f.total + "칸 (" + f.cols + " × " + f.rows + ") · 사용 중 " +
      c.used + " · 빈칸 " + c.free + (c.over ? " · 마감됨 " + c.over : "");
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
    renderFloorList(); renderGrid(); renderHeader(); renderDashCount();
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
    var f = floorById(fid); var r = RENTALS[key]; var s = statusOf(r); var st = STATE[s];
    $("dId").textContent = "No. " + pad(num);
    $("dFloor").textContent = f.name;
    var body = $("dBody"); var actions = $("dActions");

    if (!r) {
      body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
        '<div class="field"><label>학생 이름</label><input class="namefield" id="newName" placeholder="이름 입력" /></div>' +
        '<div class="field"><label>생년월일 (6자리)</label><input class="namefield" id="newBirth" placeholder="예: 880130" inputmode="numeric" maxlength="6" /></div>' +
        '<div class="field"><label>전화번호</label><input class="namefield" id="newPhone" placeholder="010-0000-0000" inputmode="tel" /></div>' +
        '<div class="field"><label>반 (마감일 = 종강일 + 10일)</label><select class="selfield" id="newClass">' + classOptionsHTML("") + "</select></div>" +
        '<div class="field"><label>안내</label><div class="v">대여를 시작하면 보증금 1만원 수령으로 기록됩니다.</div></div>';
      actions.innerHTML = '<div class="line"><button class="btn primary" id="rentBtn">대여 시작 · 보증금 1만원 수령</button></div>';
      $("rentBtn").onclick = function () {
        var nm = $("newName").value.trim();
        var ph = $("newPhone").value.trim();
        var bd = $("newBirth").value.trim();
        var cid = $("newClass").value;
        if (!nm) { $("newName").focus(); return; }
        if (bd && !/^\d{6}$/.test(bd)) { toast("생년월일은 6자리 숫자로 입력하세요. (예: 880130)"); $("newBirth").focus(); return; }
        if (!cid) { toast("반을 선택하세요. (마감일 계산에 필요)"); $("newClass").focus(); return; }
        startRental(key, nm, ph, cid, bd);
      };
      return;
    }

    var dl = deadlineOf(r); var dd = ddInfo(dl);
    var note = s === "over" ? "마감일이 지났습니다. 학생에게 연락해 연장 의사를 확인하거나 반납·보증금 환급을 처리하세요."
      : !dl ? "이 반의 종강일이 아직 입력되지 않았습니다. ‘반 관리’에서 종강일을 입력하면 마감일이 자동 계산됩니다."
      : "마감일은 반 종강일 + 10일입니다. 종강일이 갱신되면 마감일도 자동으로 미뤄집니다.";
    var dmsg = contactMsg(r, fid, num);   // 마감 안내
    var gmsg = guideMsg(r, fid, num);     // 비밀번호 이용 안내
    var deadlineContact = '<button class="btn small" id="copyDeadlineBtn">마감 안내 문구 복사</button>';
    var guideContact = '<button class="btn small" id="copyGuideBtn">안내 문구 복사</button>';
    var phoneVal = r.phone
      ? esc(r.phone) + ' <button class="btn small" id="copyPhoneBtn" style="padding:4px 9px;font-size:11px;margin-left:6px;">복사</button>'
      : "—";
    var ext = r.extended_months || 0;
    body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
      '<div class="field"><label>대여자</label><div class="v">' + esc(r.name) + "</div></div>" +
      '<div class="field"><label>생년월일</label><div class="v mono">' + (r.birth ? esc(r.birth) : "—") + "</div></div>" +
      '<div class="field"><label>전화번호</label><div class="v mono" style="display:flex;align-items:center;">' + phoneVal + "</div></div>" +
      '<div class="field"><label>반</label><div class="v">' + esc(classLabel(r)) + "</div></div>" +
      '<div class="field"><label>등록일</label><div class="v mono">' + fmtDate(r.started_on) + "</div></div>" +
      '<div class="field"><label>보증금</label><div class="v">' + (r.deposit_held ? "10,000원 수령 · 반납 시 환급" : "미수령") + "</div></div>" +
      '<div class="field"><label>이용 안내 (비밀번호)</label><div class="contact-row">' + guideContact + '</div><div class="guide-prev">' + esc(GUIDE) + "</div></div>" +
      '<div class="field"><label>마감 안내</label><div class="contact-row">' + deadlineContact + "</div></div>" +
      '<div class="deadline-box"><div class="top"><span style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)">마감일 (종강 + 10일' + (ext ? " + 연장 " + ext + "개월" : "") + ')</span>' +
      '<span class="dd" style="color:' + st.color + '">' + dd.label + "</span></div>" +
      '<div class="v mono">' + (dl ? fmtShort(dl) : "—") + '</div><div class="note">' + note + "</div>" +
      '<div class="ext-row"><span>연장 <b>' + ext + '</b>개월</span><span class="ext-btns">' +
      '<button class="btn small" id="extBtn">+1개월 연장</button>' + (ext ? '<button class="btn small" id="extReset">초기화</button>' : "") +
      "</span></div></div>";
    actions.innerHTML =
      '<div class="line"><button class="btn" id="editBtn">정보 수정</button><button class="btn" id="moveBtn">이동하기</button></div>' +
      '<div class="line"><button class="btn" id="returnBtn">반납 · 보증금 환급</button></div>';
    $("editBtn").onclick = function () { renderEdit(key); };
    $("moveBtn").onclick = function () { beginMove(key); };
    $("returnBtn").onclick = function () { returnRental(key); };
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
      '<div class="field"><label>반</label><select class="selfield" id="edClass">' + classOptionsHTML(r.class_id) + "</select></div>";
    actions.innerHTML = '<div class="line"><button class="btn primary" id="saveBtn">저장</button><button class="btn" id="cancelBtn">취소</button></div>';
    $("saveBtn").onclick = function () {
      var nm = $("edName").value.trim();
      var bd = $("edBirth").value.trim();
      if (!nm) { $("edName").focus(); return; }
      if (bd && !/^\d{6}$/.test(bd)) { toast("생년월일은 6자리 숫자로 입력하세요."); $("edBirth").focus(); return; }
      editRental(key, nm, $("edPhone").value.trim(), $("edClass").value || null, bd);
    };
    $("cancelBtn").onclick = function () { renderDrawer(); };
  }

  /* ---------- 이동 모드 ---------- */
  function beginMove(key) {
    moveSourceKey = key;
    var parts = key.split("-");
    $("moveBannerText").textContent = floorById(parseInt(parts[0], 10)).name + " No." + pad(parseInt(parts[1], 10)) +
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
    busy(true);
    sb.from("rentals").update({ locker_id: target.id }).eq("id", r.id).then(function (res) {
      busy(false);
      if (res.error) { toast("이동 실패: " + res.error.message); return; }
      logAction(target.id, "move", { from: srcKey, to: targetKey, student_name: r.name });
      moveSourceKey = null; $("moveBanner").hidden = true;
      var tp = targetKey.split("-"); currentId = parseInt(tp[0], 10);
      toast(r.name + " 님 → " + floorById(currentId).name + " No." + pad(parseInt(tp[1], 10)) + " 이동 완료");
      reload().then(function () { select(targetKey); });
    });
  }

  /* ---------- 액션 (DB 반영 + 로그) ---------- */
  function busy(on) { document.body.style.cursor = on ? "progress" : ""; }

  function startRental(key, name, phone, classId, birth) {
    var lk = LOCKERS[key];
    if (!lk) { toast("사물함 정보를 찾을 수 없습니다."); return; }
    busy(true);
    sb.from("rentals").insert({
      locker_id: lk.id, student_name: name, phone: phone || null, birth: birth || null,
      class_id: classId ? Number(classId) : null, extended_months: 0,
      started_on: todayISO(), deposit_held: true, active: true
    }).then(function (res) {
      busy(false);
      if (res.error) { toast("대여 실패: " + res.error.message); return; }
      logAction(lk.id, "rent", { student_name: name, birth: birth || "", phone: phone || "", class_label: classNameOf(classId ? Number(classId) : null) });
      toast(name + " 님 대여 시작 · 보증금 1만원 수령 · 학생에게 비밀번호 안내를 보내세요");
      reload();
    });
  }

  function editRental(key, name, phone, classId, birth) {
    var r = RENTALS[key]; if (!r) return;
    busy(true);
    sb.from("rentals").update({ student_name: name, phone: phone || null, birth: birth || null, class_id: classId ? Number(classId) : null })
      .eq("id", r.id).then(function (res) {
        busy(false);
        if (res.error) { toast("수정 실패: " + res.error.message); return; }
        logAction(LOCKERS[key] && LOCKERS[key].id, "edit", { student_name: name });
        toast("정보 수정 완료");
        reload();
      });
  }

  function extendRental(key, delta) {
    var r = RENTALS[key]; if (!r) return;
    var n = Math.max(0, (r.extended_months || 0) + delta);
    busy(true);
    sb.from("rentals").update({ extended_months: n }).eq("id", r.id).then(function (res) {
      busy(false);
      if (res.error) { toast("연장 실패: " + res.error.message); return; }
      logAction(LOCKERS[key] && LOCKERS[key].id, "extend", { student_name: r.name, months: n });
      toast(delta > 0 ? "1개월 연장했습니다. (총 " + n + "개월)" : "연장을 초기화했습니다.");
      reload();
    });
  }

  function returnRental(key) {
    var r = RENTALS[key]; if (!r) return;
    if (!window.confirm(r.name + " 님의 대여를 반납 처리하고 보증금 1만원을 환급합니까?")) return;
    busy(true);
    sb.from("rentals").update({ active: false, deposit_held: false }).eq("id", r.id).then(function (res) {
      busy(false);
      if (res.error) { toast("반납 실패: " + res.error.message); return; }
      logAction(LOCKERS[key] && LOCKERS[key].id, "return", { student_name: r.name, birth: r.birth || "", class_label: classNameOf(r.class_id) });
      toast("반납 완료 · 보증금 1만원 환급");
      reload();
    });
  }

  function logAction(lockerId, action, detail) {
    if (!lockerId && action !== "class_closing") return;
    sb.from("rental_logs").insert({ locker_id: lockerId || null, action: action, detail: detail || {} })
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
      : "각 반의 <b>날짜 선택</b>을 눌러 달력에서 종강일을 고르세요. 마감일 = 종강일 + 10일.";
  }
  function toggleClassEdit() { classEditMode = !classEditMode; applyClassMode(); renderClasses(); }

  function classGroup(cat) {
    return CLASSES.filter(function (c) { return c.category === cat; })
      .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
  }

  function renderClasses() {
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
          var p = c.closing_date ? String(c.closing_date).slice(0, 10).split("-") : null;
          var dateLabel = p ? (+p[1]) + "월 " + (+p[2]) + "일" : "날짜 선택";
          var due = c.closing_date ? "마감 " + addDaysFmt(c.closing_date, GRACE) : "";
          card.innerHTML = '<span class="cc-name">' + esc(c.name) + "</span>" +
            '<button class="cc-date' + (p ? "" : " unset") + '">' + dateLabel + "</button>" +
            '<span class="cc-due">' + due + "</span>";
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
  var calClassId = null, calY = 0, calM = 0; // calM: 1-12
  function openCalendar(c) {
    calClassId = c.id;
    if (c.closing_date) { var p = String(c.closing_date).slice(0, 10).split("-"); calY = +p[0]; calM = +p[1]; }
    else { calY = NOW.getFullYear(); calM = NOW.getMonth() + 1; }
    $("calSub").textContent = c.category + " · " + c.name + " 종강일을 선택하세요";
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
    $("calTitle").textContent = calY + "년 " + calM + "월";
    var first = new Date(calY, calM - 1, 1).getDay(); // 0=일
    var days = lastDayOf(calY, calM);
    var c = CLASSES_BY_ID[calClassId];
    var sel = 0;
    if (c && c.closing_date) { var p = String(c.closing_date).slice(0, 10).split("-"); if (+p[0] === calY && +p[1] === calM) sel = +p[2]; }
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
      (function (dd) { cell.onclick = function () { updateClosing(calClassId, calY + "-" + pad(calM) + "-" + pad(dd)); closeCalendar(); }; })(d);
      g.appendChild(cell);
    }
  }

  function setClosing(classId, date) { return sb.from("classes").update({ closing_date: date }).eq("id", classId); }
  function updateClosing(classId, date) {
    setClosing(classId, date).then(function (res) {
      if (res.error) { toast("종강일 저장 실패: " + res.error.message); return; }
      logAction(null, "class_closing", { class_id: classId, closing_date: date });
      toast(date ? "종강일 저장됨" : "종강일 지움");
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

  /* ---------- 갱신 마감 대시보드 ---------- */
  function openDash() { renderDash(); $("dashView").classList.add("open"); }
  function closeDash() { $("dashView").classList.remove("open"); }
  function renderDashIfOpen() { if ($("dashView").classList.contains("open")) renderDash(); }

  function renderDash() {
    var items = [];
    FLOORS.forEach(function (f) {
      for (var n = f.start; n <= f.end; n++) {
        var key = keyOf(f, n); var r = RENTALS[key]; if (!r) continue;
        var s = statusOf(r); var dd = ddInfo(deadlineOf(r));
        if (s === "over" || (dd.days !== null && dd.days <= SOON)) {
          items.push({ key: key, f: f, n: n, r: r, s: s, days: dd.days, label: dd.label });
        }
      }
    });
    items.sort(function (a, b) {
      var da = a.days === null ? 9999 : a.days, db = b.days === null ? 9999 : b.days;
      return da - db; // 마감 임박/경과 순
    });
    $("dashLead").textContent = "마감됨 또는 마감 " + SOON + "일 이내 · " + items.length + "건 (연락이 필요한 사물함)";
    var list = $("dashList");
    if (!items.length) { list.innerHTML = '<div class="dash-empty">연락이 필요한 사물함이 없습니다. 모두 정상입니다.</div>'; return; }
    list.innerHTML = "";
    items.forEach(function (it) {
      var st = STATE[it.s];
      var row = document.createElement("div");
      row.className = "dash-row";
      row.innerHTML = '<span class="ds-dot" style="background:' + st.color + '"></span>' +
        '<span class="ds-loc">' + it.f.name + " No." + pad(it.n) + "</span>" +
        '<span class="ds-name">' + esc(it.r.name) + "</span>" +
        '<span class="ds-phone">' + (it.r.phone ? esc(it.r.phone) : "전화 미입력") + "</span>" +
        '<span class="ds-dd" style="color:' + st.color + '">' + it.label + "</span>" +
        '<button class="btn small ds-sms">복사</button>';
      row.onclick = function () { currentId = it.f.id; closeDash(); renderAll(); select(it.key); };
      var cbtn = row.querySelector(".ds-sms");
      cbtn.addEventListener("click", function (ev) { ev.stopPropagation(); copyText(contactMsg(it.r, it.f.id, it.n)); });
      list.appendChild(row);
    });
  }

  /* ---------- 데이터 로드 ---------- */
  function loadClasses() {
    return sb.from("classes").select("id, category, name, closing_date, sort").then(function (res) {
      if (res.error) throw res.error;
      CLASSES = res.data || []; CLASSES_BY_ID = {};
      CLASSES.forEach(function (c) { CLASSES_BY_ID[c.id] = c; });
    });
  }
  function loadLockers() {
    return sb.from("lockers").select("id, floor, number").then(function (res) {
      if (res.error) throw res.error;
      LOCKERS = {};
      (res.data || []).forEach(function (l) { LOCKERS[l.floor + "-" + l.number] = l; });
    });
  }
  function loadRentals() {
    return sb.from("rentals")
      .select("id, student_name, phone, birth, class_id, extended_months, started_on, deposit_held, lockers(floor, number)")
      .eq("active", true)
      .then(function (res) {
        if (res.error) throw res.error;
        RENTALS = {};
        (res.data || []).forEach(function (row) {
          if (!row.lockers) return;
          RENTALS[row.lockers.floor + "-" + row.lockers.number] = {
            id: row.id, name: row.student_name, phone: row.phone, birth: row.birth, class_id: row.class_id,
            extended_months: row.extended_months || 0, started_on: row.started_on, deposit_held: row.deposit_held
          };
        });
      });
  }
  function reload() {
    return Promise.all([loadClasses(), loadRentals()]).then(function () {
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
  function renderNotices() {
    var list = $("noticeList"); list.innerHTML = "";
    if (!NOTICES.length) {
      list.innerHTML = '<div class="notice-empty">등록된 공지사항이 없습니다. ‘＋ 공지 작성’으로 남겨주세요.</div>';
      return;
    }
    NOTICES.slice(0, 2).forEach(function (n) { // 최신 2개만 노출
      var el = document.createElement("div"); el.className = "notice";
      el.innerHTML = '<div class="ntxt">' + esc(n.body) + "</div>" +
        '<div class="nmeta"><span class="nwho">' + esc(n.author || "직원") + '</span><span class="ntime">' + fmtNoticeTime(n.created_at) + "</span></div>" +
        '<button class="ndel" title="삭제">✕</button>';
      el.querySelector(".ndel").onclick = function () { deleteNotice(n); };
      list.appendChild(el);
    });
    if (NOTICES.length > 2) {
      var more = document.createElement("div");
      more.className = "notice-empty";
      more.textContent = "외 " + (NOTICES.length - 2) + "건 더 있습니다 (오래된 공지는 ✕로 정리하세요)";
      list.appendChild(more);
    }
  }
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

  /* ---------- 신청 기록 로그 ---------- */
  function fmtKSTDate(ts) { return new Date(ts).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }); }
  function fmtKSTTime(ts) { return new Date(ts).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" }); }
  function openLog() {
    $("logList").innerHTML = '<div class="dash-empty">불러오는 중…</div>';
    $("logView").classList.add("open");
    loadLogs();
  }
  function closeLog() { $("logView").classList.remove("open"); }
  function loadLogs() {
    sb.from("rental_logs").select("id, action, detail, created_at")
      .in("action", ["rent", "return"]).order("created_at", { ascending: false }).limit(500)
      .then(function (res) {
        if (res.error) { $("logList").innerHTML = '<div class="dash-empty">기록을 불러오지 못했습니다: ' + esc(res.error.message) + "</div>"; return; }
        renderLogs(res.data || []);
      });
  }
  function renderLogs(rows) {
    $("logLead").textContent = "대여(입금)·반납(환급) 기록 · " + rows.length + "건 · 한국시간";
    var list = $("logList");
    if (!rows.length) { list.innerHTML = '<div class="dash-empty">아직 기록이 없습니다.</div>'; return; }
    list.innerHTML = "";
    rows.forEach(function (l) {
      var d = l.detail || {};
      var isRent = l.action === "rent";
      var row = document.createElement("div");
      row.className = "log-row";
      row.innerHTML = '<span class="log-act ' + (isRent ? "in" : "out") + '">' + (isRent ? "입금" : "환급") + "</span>" +
        '<span class="log-name">' + esc(d.student_name || "") + "</span>" +
        '<span class="log-birth">' + esc(d.birth || "") + "</span>" +
        '<span class="log-class">' + esc(d.class_label || "") + "</span>" +
        '<span class="log-date">' + fmtKSTDate(l.created_at) + "</span>" +
        '<span class="log-time">' + fmtKSTTime(l.created_at) + "</span>";
      list.appendChild(row);
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
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, function () { loadSettings().then(function () { if (selectedKey) renderDrawer(); }); })
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
    loadLockers().then(function () { return Promise.all([loadClasses(), loadRentals(), loadNotices(), loadSettings()]); }).then(function () {
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
  $("classBtn").onclick = openClasses;
  $("classClose").onclick = closeClasses;
  $("classEditBtn").onclick = toggleClassEdit;
  $("logBtn").onclick = openLog;
  $("logClose").onclick = closeLog;
  $("addClassBtn").onclick = addClass;
  $("newClassName").addEventListener("keydown", function (e) { if (e.key === "Enter") addClass(); });
  $("moveCancel").onclick = cancelMove;
  $("calPrev").onclick = function () { calShift(-1); };
  $("calNext").onclick = function () { calShift(1); };
  $("calClose").onclick = closeCalendar;
  $("calClear").onclick = function () { if (calClassId) { updateClosing(calClassId, null); closeCalendar(); } };
  $("guideBtn").onclick = openGuide;
  $("guideSave").onclick = saveGuide;
  $("guideCancel").onclick = closeGuide;
  $("noticeAddBtn").onclick = openNotice;
  $("noticePost").onclick = postNotice;
  $("noticeCancel").onclick = closeNotice;
  $("noticeBody").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postNotice(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("calView").classList.contains("open")) closeCalendar();
    else if ($("logView").classList.contains("open")) closeLog();
    else if ($("guideView").classList.contains("open")) closeGuide();
    else if ($("noticeView").classList.contains("open")) closeNotice();
    else if ($("classView").classList.contains("open")) closeClasses();
    else if ($("dashView").classList.contains("open")) closeDash();
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
    else { entered = false; unsubscribeRealtime(); closeDrawer(); closeDash(); closeClasses(); closeCalendar(); closeLog(); closeNotice(); closeGuide(); cancelMove(); NOTICES = []; showLogin(); }
  });
})();
