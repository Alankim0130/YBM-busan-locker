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

  function floorById(id) { return FLOORS.find(function (f) { return f.id === id; }); }
  function keyOf(f, n) { return f.id + "-" + n; }

  /* ---------- 마감일 / 상태 ---------- */
  function deadlineOf(r) {
    if (!r || !r.class_id) return null;
    var c = CLASSES_BY_ID[r.class_id];
    if (!c || !c.closing_date) return null;
    var d = parseDate(c.closing_date);
    d.setDate(d.getDate() + GRACE);
    d.setHours(23, 59, 0, 0);
    return d;
  }
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

  /* ---------- 연락 (무료·수동: 직원 폰 문자/전화 앱 열기) ---------- */
  function digits(s) { return String(s || "").replace(/[^0-9]/g, ""); }
  function contactMsg(r, fid, num) {
    var f = floorById(fid); var dl = deadlineOf(r);
    var when = dl ? fmtShort(dl) : "곧 마감 예정";
    return "[서면 YBM] " + r.name + "님, " + f.name + " " + pad(num) + "번 사물함 마감일이 " + when +
      "입니다. 계속 사용하시려면 데스크로 연장 의사를 알려주세요. 감사합니다.";
  }
  function smsHref(phone, msg) { return "sms:" + digits(phone) + "?body=" + encodeURIComponent(msg); }
  function telHref(phone) { return "tel:" + digits(phone); }
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
      btn.innerHTML = '<div class="floor-left"><span class="fname">' + f.name + "</span>" +
        '<div class="fbar">' +
          '<span class="seg" style="flex:' + c.free + ';background:var(--free)"></span>' +
          '<span class="seg" style="flex:' + Math.max(c.used - c.over, 0) + ';background:var(--rent)"></span>' +
          '<span class="seg" style="flex:' + c.over + ';background:var(--over)"></span>' +
        "</div></div><span class=\"fmeta\">" + c.free + "/" + f.total + " 빈칸</span>";
      btn.onclick = function () { currentId = f.id; closeDrawer(); renderAll(); };
      list.appendChild(btn);
    });
  }

  function renderGrid() {
    var f = floorById(currentId);
    grid.style.gridTemplateColumns = "repeat(" + f.cols + ",112px)";
    var rowsCss = [];
    for (var rr = 0; rr < f.rows; rr++) { rowsCss.push((f.tallCount > 0 && rr === 0) ? "106px" : "80px"); }
    grid.style.gridTemplateRows = rowsCss.join(" ");
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
        '<div class="field"><label>전화번호</label><input class="namefield" id="newPhone" placeholder="010-0000-0000" inputmode="tel" /></div>' +
        '<div class="field"><label>반 (마감일 = 종강일 + 10일)</label><select class="selfield" id="newClass">' + classOptionsHTML("") + "</select></div>" +
        '<div class="field"><label>안내</label><div class="v">대여를 시작하면 보증금 1만원 수령으로 기록됩니다.</div></div>';
      actions.innerHTML = '<div class="line"><button class="btn primary" id="rentBtn">대여 시작 · 보증금 1만원 수령</button></div>';
      $("rentBtn").onclick = function () {
        var nm = $("newName").value.trim();
        var ph = $("newPhone").value.trim();
        var cid = $("newClass").value;
        if (!nm) { $("newName").focus(); return; }
        if (!cid) { toast("반을 선택하세요. (마감일 계산에 필요)"); $("newClass").focus(); return; }
        startRental(key, nm, ph, cid);
      };
      return;
    }

    var dl = deadlineOf(r); var dd = ddInfo(dl);
    var note = s === "over" ? "마감일이 지났습니다. 학생에게 연락해 연장 의사를 확인하거나 반납·보증금 환급을 처리하세요."
      : !dl ? "이 반의 종강일이 아직 입력되지 않았습니다. ‘반 관리’에서 종강일을 입력하면 마감일이 자동 계산됩니다."
      : "마감일은 반 종강일 + 10일입니다. 종강일이 갱신되면 마감일도 자동으로 미뤄집니다.";
    var cmsg = contactMsg(r, fid, num);
    var contactHTML = r.phone
      ? '<div class="contact-row"><a class="btn small" href="' + smsHref(r.phone, cmsg) + '">문자</a>' +
        '<a class="btn small" href="' + telHref(r.phone) + '">전화</a>' +
        '<button class="btn small" id="copyMsgBtn">문구 복사</button></div>'
      : '<div class="v" style="color:var(--ink-soft);font-size:13px;">전화번호가 없습니다. ‘정보 수정’에서 입력하세요.</div>';
    body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
      '<div class="field"><label>대여자</label><div class="v">' + esc(r.name) + "</div></div>" +
      '<div class="field"><label>전화번호</label><div class="v mono">' + (r.phone ? esc(r.phone) : "—") + "</div></div>" +
      '<div class="field"><label>반</label><div class="v">' + esc(classLabel(r)) + "</div></div>" +
      '<div class="field"><label>등록일</label><div class="v mono">' + fmtDate(r.started_on) + "</div></div>" +
      '<div class="field"><label>보증금</label><div class="v">' + (r.deposit_held ? "10,000원 수령 · 반납 시 환급" : "미수령") + "</div></div>" +
      '<div class="field"><label>연락 (마감 안내)</label>' + contactHTML + "</div>" +
      '<div class="deadline-box"><div class="top"><span style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)">마감일 (종강 + 10일)</span>' +
      '<span class="dd" style="color:' + st.color + '">' + dd.label + "</span></div>" +
      '<div class="v mono">' + (dl ? fmtShort(dl) : "—") + '</div><div class="note">' + note + "</div></div>";
    actions.innerHTML =
      '<div class="line"><button class="btn" id="editBtn">정보 수정</button><button class="btn" id="moveBtn">사물함 이동</button></div>' +
      '<div class="line"><button class="btn" id="returnBtn">반납 · 보증금 환급</button></div>';
    $("editBtn").onclick = function () { renderEdit(key); };
    $("moveBtn").onclick = function () { beginMove(key); };
    $("returnBtn").onclick = function () { returnRental(key); };
    var cb = $("copyMsgBtn"); if (cb) cb.onclick = function () { copyText(cmsg); };
  }

  function renderEdit(key) {
    var r = RENTALS[key]; if (!r) return;
    var body = $("dBody"); var actions = $("dActions");
    body.innerHTML =
      '<div class="field"><label>학생 이름</label><input class="namefield" id="edName" value="' + esc(r.name) + '" /></div>' +
      '<div class="field"><label>전화번호</label><input class="namefield" id="edPhone" value="' + esc(r.phone || "") + '" inputmode="tel" /></div>' +
      '<div class="field"><label>반</label><select class="selfield" id="edClass">' + classOptionsHTML(r.class_id) + "</select></div>";
    actions.innerHTML = '<div class="line"><button class="btn primary" id="saveBtn">저장</button><button class="btn" id="cancelBtn">취소</button></div>';
    $("saveBtn").onclick = function () {
      var nm = $("edName").value.trim();
      if (!nm) { $("edName").focus(); return; }
      editRental(key, nm, $("edPhone").value.trim(), $("edClass").value || null);
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

  function startRental(key, name, phone, classId) {
    var lk = LOCKERS[key];
    if (!lk) { toast("사물함 정보를 찾을 수 없습니다."); return; }
    busy(true);
    sb.from("rentals").insert({
      locker_id: lk.id, student_name: name, phone: phone || null,
      class_id: classId ? Number(classId) : null,
      started_on: todayISO(), deposit_held: true, active: true
    }).then(function (res) {
      busy(false);
      if (res.error) { toast("대여 실패: " + res.error.message); return; }
      logAction(lk.id, "rent", { student_name: name, phone: phone });
      toast(name + " 님 대여 시작 · 보증금 1만원 수령");
      reload();
    });
  }

  function editRental(key, name, phone, classId) {
    var r = RENTALS[key]; if (!r) return;
    busy(true);
    sb.from("rentals").update({ student_name: name, phone: phone || null, class_id: classId ? Number(classId) : null })
      .eq("id", r.id).then(function (res) {
        busy(false);
        if (res.error) { toast("수정 실패: " + res.error.message); return; }
        logAction(LOCKERS[key] && LOCKERS[key].id, "edit", { student_name: name });
        toast("정보 수정 완료");
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
      logAction(LOCKERS[key] && LOCKERS[key].id, "return", { student_name: r.name });
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

  function openClasses() { renderClasses(); refreshCatList(); $("classView").classList.add("open"); }
  function closeClasses() { $("classView").classList.remove("open"); }
  function refreshCatList() {
    $("catList").innerHTML = orderedCategories().map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
  }

  function renderClasses() {
    var list = $("classList"); list.innerHTML = "";
    if (!CLASSES.length) { list.innerHTML = '<div class="dash-empty">등록된 반이 없습니다. 위에서 추가하세요.</div>'; return; }
    orderedCategories().forEach(function (cat) {
      var lbl = document.createElement("div");
      lbl.className = "class-cat-label"; lbl.textContent = cat;
      list.appendChild(lbl);
      CLASSES.filter(function (c) { return c.category === cat; })
        .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); })
        .forEach(function (c) {
          var dl = c.closing_date ? (function () { var d = parseDate(c.closing_date); d.setDate(d.getDate() + GRACE); return fmtDate(d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())); })() : "—";
          var row = document.createElement("div");
          row.className = "class-row";
          row.innerHTML = '<span class="cl-name">' + esc(c.name) + "</span>" +
            '<input type="date" value="' + (c.closing_date ? String(c.closing_date).slice(0, 10) : "") + '" data-id="' + c.id + '" />' +
            '<span class="cl-due">마감 ' + dl + "</span>" +
            '<button class="cl-del" data-id="' + c.id + '" title="삭제">&times;</button>';
          row.querySelector("input").onchange = function (e) { updateClosing(c.id, e.target.value || null); };
          row.querySelector(".cl-del").onclick = function () { deleteClass(c); };
          list.appendChild(row);
        });
    });
  }

  function updateClosing(classId, date) {
    sb.from("classes").update({ closing_date: date }).eq("id", classId).then(function (res) {
      if (res.error) { toast("종강일 저장 실패: " + res.error.message); return; }
      logAction(null, "class_closing", { class_id: classId, closing_date: date });
      toast("종강일 저장됨");
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
      var smsBtn = it.r.phone
        ? '<a class="btn small ds-sms" href="' + smsHref(it.r.phone, contactMsg(it.r, it.f.id, it.n)) + '">문자</a>'
        : "";
      row.innerHTML = '<span class="ds-dot" style="background:' + st.color + '"></span>' +
        '<span class="ds-loc">' + it.f.name + " No." + pad(it.n) + "</span>" +
        '<span class="ds-name">' + esc(it.r.name) + "</span>" +
        '<span class="ds-phone">' + (it.r.phone ? esc(it.r.phone) : "전화 미입력") + "</span>" +
        '<span class="ds-dd" style="color:' + st.color + '">' + it.label + "</span>" + smsBtn;
      row.onclick = function () { currentId = it.f.id; closeDash(); renderAll(); select(it.key); };
      var a = row.querySelector(".ds-sms");
      if (a) a.addEventListener("click", function (ev) { ev.stopPropagation(); });
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
      .select("id, student_name, phone, class_id, started_on, deposit_held, lockers(floor, number)")
      .eq("active", true)
      .then(function (res) {
        if (res.error) throw res.error;
        RENTALS = {};
        (res.data || []).forEach(function (row) {
          if (!row.lockers) return;
          RENTALS[row.lockers.floor + "-" + row.lockers.number] = {
            id: row.id, name: row.student_name, phone: row.phone, class_id: row.class_id,
            started_on: row.started_on, deposit_held: row.deposit_held
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
    return m.name || m.full_name || m.display_name || (u.email ? u.email.split("@")[0] : "직원");
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
      list.innerHTML = '<div class="notice-empty">특별공지 없음 · 특이사항이 있으면 오른쪽 ‘＋ 특별공지’로 남겨주세요.</div>';
      return;
    }
    NOTICES.forEach(function (n) {
      var el = document.createElement("div"); el.className = "notice";
      el.innerHTML = '<div class="ntxt">' + esc(n.body) + "</div>" +
        '<div class="nmeta"><span class="nwho">' + esc(n.author || "직원") + "</span><span>" + fmtNoticeTime(n.created_at) + "</span></div>" +
        '<button class="ndel" title="삭제">✕</button>';
      el.querySelector(".ndel").onclick = function () { deleteNotice(n); };
      list.appendChild(el);
    });
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
      closeNotice(); toast("특별공지를 등록했습니다."); loadNotices();
    });
  }
  function deleteNotice(n) {
    if (!window.confirm("이 공지를 삭제할까요?\n\n" + n.body)) return;
    sb.from("notices").delete().eq("id", n.id).then(function (res) {
      if (res.error) { toast("삭제 실패: " + res.error.message); return; }
      toast("공지를 삭제했습니다."); loadNotices();
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
    $("userEmail").textContent = ME.email || ME.name;
    $("userBox").hidden = false;
    $("noticeBar").hidden = false;
    if (entered) return;
    entered = true;
    busy(true);
    loadLockers().then(function () { return Promise.all([loadClasses(), loadRentals(), loadNotices()]); }).then(function () {
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
  $("addClassBtn").onclick = addClass;
  $("newClassName").addEventListener("keydown", function (e) { if (e.key === "Enter") addClass(); });
  $("moveCancel").onclick = cancelMove;
  $("noticeAddBtn").onclick = openNotice;
  $("noticePost").onclick = postNotice;
  $("noticeCancel").onclick = closeNotice;
  $("noticeBody").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postNotice(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("noticeView").classList.contains("open")) closeNotice();
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
    else { entered = false; unsubscribeRealtime(); closeDrawer(); closeDash(); closeClasses(); closeNotice(); cancelMove(); NOTICES = []; showLogin(); }
  });
})();
