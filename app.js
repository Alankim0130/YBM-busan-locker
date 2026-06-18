/* ============================================================
   서면 YBM 사물함 관리 — Supabase 연동 로직
   - 인증: Supabase Auth (이메일/비밀번호)
   - 데이터: lockers / rentals / rental_logs (RLS 보호)
   - 멀티 PC 동기화: rentals 테이블 Realtime 구독
   - 상태(free/rent/due/over)는 저장하지 않고 조회 시 계산
   ============================================================ */
(function () {
  "use strict";

  /* ---------- 설정 확인 ---------- */
  var URL = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
  function configured() {
    return URL && KEY && URL.indexOf("YOUR-") === -1 && KEY.indexOf("YOUR-") === -1;
  }
  var $ = function (id) { return document.getElementById(id); };
  if (!configured()) { $("setupView").classList.add("open"); return; }

  var sb = window.supabase.createClient(URL, KEY);

  /* ---------- 날짜 / 갱신 마감 ---------- */
  function lastFridayOfMonth(y, m) {
    var d = new Date(y, m + 1, 0);
    var back = (d.getDay() - 5 + 7) % 7;
    d.setDate(d.getDate() - back);
    d.setHours(23, 59, 0, 0);
    return d;
  }
  var NOW = new Date();
  var DEADLINE = lastFridayOfMonth(NOW.getFullYear(), NOW.getMonth());
  var DAY = 86400000;
  function pad(n) { return String(n).padStart(2, "0"); }
  var CUR_MONTH = NOW.getFullYear() + "-" + pad(NOW.getMonth() + 1); // 'YYYY-MM'
  function fmtShort(d) {
    var w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
    return (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + w + ")";
  }
  function fmtDate(iso) { // 'YYYY-MM-DD' -> 'YYYY.MM.DD'
    if (!iso) return "—";
    var p = String(iso).slice(0, 10).split("-");
    return p[0] + "." + p[1] + "." + p[2];
  }
  function todayISO() {
    return NOW.getFullYear() + "-" + pad(NOW.getMonth() + 1) + "-" + pad(NOW.getDate());
  }
  $("deadlineText").textContent = fmtShort(DEADLINE);

  /* ---------- 실제 층 구성 (격자 기하) ---------- */
  var FLOORS = [
    { id: 1, name: "1층", cols: 6, rows: 5, start: 1,  tallCount: 0 },
    { id: 2, name: "2층", cols: 5, rows: 5, start: 31, tallCount: 0 },
    { id: 3, name: "3층", cols: 6, rows: 6, start: 56, tallCount: 6 },
    { id: 7, name: "7층", cols: 6, rows: 6, start: 1,  tallCount: 6 }
  ];
  FLOORS.forEach(function (f) { f.total = f.cols * f.rows; f.end = f.start + f.total - 1; });

  var STATE = {
    free: { c: "var(--free)", label: "사용 가능", color: "#3ba776" },
    rent: { c: "var(--rent)", label: "사용 중",   color: "#3b6fd4" },
    due:  { c: "var(--due)",  label: "갱신 임박", color: "#e0a100" },
    over: { c: "var(--over)", label: "연체",      color: "#d7503a" }
  };

  /* ---------- 메모리 캐시 ---------- */
  var LOCKERS = {}; // "floor-number" -> { id, floor, number }
  var RENTALS = {}; // "floor-number" -> { id, name, started_on, confirmed_month, deposit_held }

  function floorById(id) { return FLOORS.find(function (f) { return f.id === id; }); }
  function keyOf(f, n) { return f.id + "-" + n; }

  function statusOf(r) {
    if (!r) return "free";
    if (r.confirmed_month === CUR_MONTH) return "rent"; // 이번 달 갱신 확인됨
    if (NOW > DEADLINE) return "over";                  // 마감 경과·미확인
    if (DEADLINE - NOW <= 7 * DAY) return "due";        // 마감 7일 이내·미확인
    return "rent";
  }

  /* ---------- 카운트 ---------- */
  function counts(f) {
    var used = 0, due = 0, over = 0;
    for (var n = f.start; n <= f.end; n++) {
      var s = statusOf(RENTALS[keyOf(f, n)]);
      if (s !== "free") used++;
      if (s === "due") due++;
      if (s === "over") over++;
    }
    return { used: used, due: due, over: over, free: f.total - used };
  }

  /* ---------- 렌더링 ---------- */
  var currentId = 1, selectedKey = null;
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
          '<span class="seg" style="flex:' + Math.max(c.used - c.due - c.over, 0) + ';background:var(--rent)"></span>' +
          '<span class="seg" style="flex:' + c.due + ';background:var(--due)"></span>' +
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
      el.className = "locker" + (key === selectedKey ? " sel" : "");
      el.style.setProperty("--c", st.c);
      el.innerHTML = '<span class="id">' + pad(n) + '</span><span class="who">' + (r ? r.name : "비어 있음") + '</span><span class="handle"></span>';
      (function (k) { el.onclick = function () { select(k); }; })(key);
      grid.appendChild(el);
    }
  }

  function renderHeader() {
    var f = floorById(currentId); var c = counts(f);
    $("floorTitle").textContent = f.name + " 사물함";
    $("floorSub").textContent = "전체 " + f.total + "칸 (" + f.cols + " × " + f.rows + ") · 사용 중 " +
      c.used + " · 빈칸 " + c.free + (c.due ? " · 갱신 임박 " + c.due : "") + (c.over ? " · 연체 " + c.over : "");
  }

  function renderDashCount() {
    var total = 0;
    FLOORS.forEach(function (f) { var c = counts(f); total += c.due + c.over; });
    var el = $("dashCount");
    el.textContent = total;
    el.classList.toggle("alert", total > 0);
  }

  function renderAll() {
    renderFloorList(); renderGrid(); renderHeader(); renderDashCount();
    if (selectedKey) renderDrawer();
  }

  function select(key) { selectedKey = key; renderGrid(); renderDrawer(); drawer.classList.add("open"); }
  function closeDrawer() { selectedKey = null; drawer.classList.remove("open"); renderGrid(); }

  /* ---------- 상세 패널 ---------- */
  function renderDrawer() {
    var key = selectedKey; if (!key) return;
    var parts = key.split("-"); var fid = parseInt(parts[0], 10); var num = parseInt(parts[1], 10);
    var f = floorById(fid); var r = RENTALS[key]; var s = statusOf(r); var st = STATE[s];
    $("dId").textContent = "No. " + pad(num);
    $("dFloor").textContent = f.name;
    var body = $("dBody"); var actions = $("dActions");

    if (!r) {
      body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
        '<div class="field"><label>안내</label><div class="v">대여 가능한 사물함입니다. 학생 이름을 입력하고 대여를 시작하면 보증금 1만원 수령으로 기록됩니다.</div></div>' +
        '<input class="namefield" id="newName" placeholder="학생 이름 입력" />';
      actions.innerHTML = '<div class="line"><button class="btn primary" id="rentBtn">대여 시작 · 보증금 1만원 수령</button></div>';
      $("rentBtn").onclick = function () {
        var nm = $("newName").value.trim();
        if (!nm) { $("newName").focus(); return; }
        startRental(key, nm);
      };
      var nf = $("newName");
      nf.addEventListener("keydown", function (e) { if (e.key === "Enter") $("rentBtn").click(); });
      return;
    }

    var ddDays = Math.ceil((DEADLINE - NOW) / DAY);
    var ddLabel = ddDays > 0 ? "D-" + ddDays : (ddDays === 0 ? "D-DAY" : "마감 " + Math.abs(ddDays) + "일 경과");
    var confirmed = r.confirmed_month === CUR_MONTH;
    var note = s === "over" ? "마감일까지 갱신 의사를 확인하지 못했습니다. 학생에게 연락하거나 반납·보증금 환급을 처리하세요."
      : s === "due" ? "갱신 마감이 임박했습니다. 연장 의사를 확인하고 갱신 확인을 눌러주세요."
      : "이번 달 갱신이 확인되었습니다.";
    body.innerHTML = '<span class="badge" style="background:' + st.color + '"><span class="bd"></span>' + st.label + "</span>" +
      '<div class="field"><label>대여자</label><div class="v">' + r.name + "</div></div>" +
      '<div class="field"><label>등록일</label><div class="v mono">' + fmtDate(r.started_on) + "</div></div>" +
      '<div class="field"><label>보증금</label><div class="v">' + (r.deposit_held ? "10,000원 수령 · 반납 시 환급" : "미수령") + "</div></div>" +
      '<div class="deadline-box"><div class="top"><span style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)">이번 달 갱신 마감</span>' +
      '<span class="dd" style="color:' + st.color + '">' + ddLabel + "</span></div>" +
      '<div class="v mono">' + fmtShort(DEADLINE) + '</div><div class="note">' + note + "</div></div>";
    actions.innerHTML = '<div class="line"><button class="btn" id="confirmBtn" ' + (confirmed ? "disabled" : "") + ">" +
      (confirmed ? "갱신 확인됨" : "갱신 확인") + "</button>" +
      '<button class="btn" id="returnBtn">반납 · 보증금 환급</button></div>';
    if (!confirmed) $("confirmBtn").onclick = function () { confirmRenew(key); };
    $("returnBtn").onclick = function () { returnRental(key); };
  }

  /* ---------- 액션 (DB 반영 + 로그) ---------- */
  function busy(on) { document.body.style.cursor = on ? "progress" : ""; }

  function startRental(key, name) {
    var lk = LOCKERS[key];
    if (!lk) { toast("사물함 정보를 찾을 수 없습니다."); return; }
    busy(true);
    sb.from("rentals").insert({
      locker_id: lk.id, student_name: name, started_on: todayISO(),
      deposit_held: true, confirmed_month: CUR_MONTH, active: true
    }).then(function (res) {
      busy(false);
      if (res.error) { toast("대여 실패: " + res.error.message); return; }
      logAction(lk.id, "rent", { student_name: name });
      toast(name + " 님 대여 시작 · 보증금 1만원 수령");
      reload();
    });
  }

  function confirmRenew(key) {
    var r = RENTALS[key]; if (!r) return;
    busy(true);
    sb.from("rentals").update({ confirmed_month: CUR_MONTH }).eq("id", r.id).then(function (res) {
      busy(false);
      if (res.error) { toast("갱신 확인 실패: " + res.error.message); return; }
      logAction(LOCKERS[key] && LOCKERS[key].id, "renew_confirm", { month: CUR_MONTH });
      toast("갱신 확인 완료");
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
    if (!lockerId) return;
    sb.from("rental_logs").insert({ locker_id: lockerId, action: action, detail: detail || {} })
      .then(function () {}, function () {}); // 로그 실패는 무시
  }

  /* ---------- 데이터 로드 ---------- */
  function loadLockers() {
    return sb.from("lockers").select("id, floor, number").then(function (res) {
      if (res.error) throw res.error;
      LOCKERS = {};
      (res.data || []).forEach(function (l) { LOCKERS[l.floor + "-" + l.number] = l; });
    });
  }

  function loadRentals() {
    return sb.from("rentals")
      .select("id, student_name, started_on, deposit_held, confirmed_month, lockers(floor, number)")
      .eq("active", true)
      .then(function (res) {
        if (res.error) throw res.error;
        RENTALS = {};
        (res.data || []).forEach(function (row) {
          if (!row.lockers) return;
          RENTALS[row.lockers.floor + "-" + row.lockers.number] = {
            id: row.id, name: row.student_name, started_on: row.started_on,
            confirmed_month: row.confirmed_month, deposit_held: row.deposit_held
          };
        });
      });
  }

  function reload() {
    loadRentals().then(function () { renderAll(); renderDashIfOpen(); })
      .catch(function (e) { toast("데이터 로드 실패: " + (e.message || e)); });
  }

  /* ---------- 갱신 마감 대시보드 ---------- */
  function openDash() {
    renderDash();
    $("dashView").classList.add("open");
  }
  function closeDash() { $("dashView").classList.remove("open"); }
  function renderDashIfOpen() { if ($("dashView").classList.contains("open")) renderDash(); }

  function renderDash() {
    var items = [];
    FLOORS.forEach(function (f) {
      for (var n = f.start; n <= f.end; n++) {
        var key = keyOf(f, n); var r = RENTALS[key]; var s = statusOf(r);
        if (s === "due" || s === "over") items.push({ key: key, f: f, n: n, r: r, s: s });
      }
    });
    items.sort(function (a, b) {
      if (a.s !== b.s) return a.s === "over" ? -1 : 1; // 연체 먼저
      return 0;
    });
    var ddDays = Math.ceil((DEADLINE - NOW) / DAY);
    var ddLabel = ddDays > 0 ? "D-" + ddDays : (ddDays === 0 ? "D-DAY" : "마감 " + Math.abs(ddDays) + "일 경과");
    $("dashLead").textContent = "이번 달 마감 " + fmtShort(DEADLINE) + " · " + ddLabel + " · 미확인 " + items.length + "건";
    var list = $("dashList");
    if (!items.length) { list.innerHTML = '<div class="dash-empty">미확인 사물함이 없습니다. 모두 정상입니다.</div>'; return; }
    list.innerHTML = "";
    items.forEach(function (it) {
      var st = STATE[it.s];
      var row = document.createElement("div");
      row.className = "dash-row";
      row.innerHTML = '<span class="ds-dot" style="background:' + st.color + '"></span>' +
        '<span class="ds-loc">' + it.f.name + " No." + pad(it.n) + "</span>" +
        '<span class="ds-name">' + (it.r ? it.r.name : "—") + "</span>" +
        '<span class="ds-dd" style="color:' + st.color + '">' + st.label + "</span>";
      row.onclick = function () { currentId = it.f.id; closeDash(); renderAll(); select(it.key); };
      list.appendChild(row);
    });
  }

  /* ---------- Realtime (멀티 PC 동기화) ---------- */
  var channel = null;
  function subscribeRealtime() {
    if (channel) return;
    channel = sb.channel("rentals-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "rentals" }, function () { reload(); })
      .subscribe();
  }
  function unsubscribeRealtime() {
    if (channel) { sb.removeChannel(channel); channel = null; }
  }

  /* ---------- 토스트 ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* ---------- 인증 게이트 ---------- */
  var entered = false;

  function showLogin() {
    $("userBox").hidden = true;
    $("loginView").classList.add("open");
  }

  function enterApp(session) {
    $("loginView").classList.remove("open");
    $("userEmail").textContent = (session && session.user && session.user.email) || "직원";
    $("userBox").hidden = false;
    if (entered) return;
    entered = true;
    busy(true);
    loadLockers().then(loadRentals).then(function () {
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
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if ($("dashView").classList.contains("open")) closeDash();
      else closeDrawer();
    }
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
      // onAuthStateChange 가 enterApp 을 호출
    });
  });

  $("logoutBtn").onclick = function () {
    sb.auth.signOut();
  };

  /* ---------- 시작 ---------- */
  sb.auth.getSession().then(function (res) {
    var session = res.data && res.data.session;
    if (session) enterApp(session); else showLogin();
  });

  sb.auth.onAuthStateChange(function (event, session) {
    if (session) {
      enterApp(session);
    } else {
      entered = false;
      unsubscribeRealtime();
      closeDrawer(); closeDash();
      showLogin();
    }
  });
})();
