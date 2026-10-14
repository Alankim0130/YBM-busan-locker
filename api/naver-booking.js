// ============================================================
// Vercel 서버리스 함수 — 네이버예약(강사 상담) 공개 현황 중계
// ------------------------------------------------------------
// 브라우저는 네이버에 직접 요청할 수 없어(CORS) 여기서 대신 읽는다.
// 첫토익·역전토익과 같은 방식: 공개 예약 페이지가 쓰는 GraphQL(hourlySchedule).
//   - 조회 전용 · 예약자 정보 없음(칸마다 건수·정원뿐)
//   - 로그인한 직원만 호출 가능 (Supabase 로그인 토큰 확인) — 외부인이 이 함수를
//     이용해 네이버에 요청을 쏟아붓지 못하게
//   - 강사 목록은 아래 ITEMS 고정 → 임의 주소 중계 불가
//   - 결과는 60초 동안 재사용(동시 요청은 한 번만 조회) → 직원 PC가 여러 대여도 네이버 호출이 늘지 않게
// 주의(역전토익 실측):
//   - 날짜는 시간대 표시 없이 보낸다(+09:00 을 붙이면 본문 오류)
//   - 응답 모양이 이상하면 0으로 메우지 말고 그 강사는 오류로 돌려준다
//     (0으로 메우면 예약이 전부 '취소'로 보이는 거짓 알림이 난다)
// ============================================================

const BUSINESS = { businessTypeId: 12, businessId: "459658" };

const ITEMS = [
  { id: "4139011", name: "역전토익" },
  { id: "6523641", name: "벨라토익" },
  { id: "3736463", name: "첫토익" },
  { id: "6247491", name: "독한토익" },
  { id: "6108857", name: "밀착토익" },
  { id: "7270580", name: "브라이언오픽" },
];

// 예약을 여는 기간보다 길어야 먼 날짜 예약도 변동으로 잡힌다
const DAYS_AHEAD = 60;

const QUERY =
  "query hourlySchedule($scheduleParams: ScheduleParams) { schedule(input: $scheduleParams) { bizItemSchedule { hourly { unitStartTime bookingCount stock isUnitSaleDay isUnitBusinessDay } } } }";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function kstDay(offset) {
  return new Date(Date.now() + 9 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

const isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 10000;

// 응답 → 칸 목록. 하나라도 이상하면 통째로 거절(Error)
function parseHourly(body) {
  if (!body || typeof body !== "object") throw new Error("응답이 JSON 객체가 아님");
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new Error("네이버 오류: " + String((body.errors[0] && body.errors[0].message) || "알 수 없음").slice(0, 160));
  }
  const hourly = body.data && body.data.schedule && body.data.schedule.bizItemSchedule && body.data.schedule.bizItemSchedule.hourly;
  if (!Array.isArray(hourly)) throw new Error("hourly 목록 없음(응답 모양 변경 가능성)");
  const out = [];
  const byTime = {};
  hourly.forEach(function (h, i) {
    if (!h || typeof h !== "object") throw new Error(i + "번째 칸이 객체가 아님");
    const m = typeof h.unitStartTime === "string" && h.unitStartTime.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (!m) throw new Error(i + "번째 칸 시각 오류");
    if (!isCount(h.bookingCount)) throw new Error(i + "번째 칸 bookingCount 오류");
    if (!isCount(h.stock)) throw new Error(i + "번째 칸 stock 오류");
    // 시각은 한국 벽시계 "YYYY-MM-DD HH:MM" 그대로 전달 · 같은 시각이 또 오면 합친다
    const t = m[1] + " " + m[2];
    const open = h.isUnitSaleDay !== false && h.isUnitBusinessDay !== false;
    if (byTime[t]) { byTime[t].b += h.bookingCount; byTime[t].s += h.stock; byTime[t].open = byTime[t].open || open; return; }
    byTime[t] = { t: t, b: h.bookingCount, s: h.stock, open: open };
    out.push(byTime[t]);
  });
  out.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
  return out;
}

async function fetchItem(item, from, to) {
  const res = await fetch("https://m.booking.naver.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Referer: "https://m.booking.naver.com/booking/12/bizes/" + BUSINESS.businessId + "/items/" + item.id,
    },
    body: JSON.stringify({
      operationName: "hourlySchedule",
      query: QUERY,
      variables: {
        scheduleParams: {
          businessTypeId: BUSINESS.businessTypeId,
          businessId: BUSINESS.businessId,
          bizItemId: item.id,
          startDateTime: from + "T00:00:00",
          endDateTime: to + "T23:59:59",
          fixedTime: true,
        },
      },
    }),
  });
  if (!res.ok) throw new Error("네이버 응답 " + res.status);
  return parseHourly(await res.json());
}

// 사물함 웹(config.js)과 같은 Supabase 주소·공개(anon) 키 — 공개 전제의 키라 여기 적어도 된다.
// Vercel 환경 변수(SUPABASE_URL / SUPABASE_ANON_KEY)가 있으면 그 값을 쓴다.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://jueuulxandnmpladwjto.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1ZXV1bHhhbmRubXBsYWR3anRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3NzQ0MTAsImV4cCI6MjA5NzM1MDQxMH0.nACXq57uGsuf0uyhVM5pUFJdlJ2k9MAK8V_IrKvypDw";

// 로그인한 직원인지 — 브라우저가 보낸 Supabase 로그인 토큰을 Supabase 에 물어 확인
async function isStaff(req) {
  const m = String((req.headers && req.headers.authorization) || "").match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/);
  if (!m) return false;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + m[1] },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id && u.aud === "authenticated");
  } catch (e) {
    return false;
  }
}

async function build() {
  const from = kstDay(0);
  const to = kstDay(DAYS_AHEAD);
  const results = await Promise.all(
    ITEMS.map(function (item) {
      return fetchItem(item, from, to).then(
        function (slots) { return { id: item.id, name: item.name, ok: true, slots: slots }; },
        function (e) { return { id: item.id, name: item.name, ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
      );
    })
  );
  return JSON.stringify({ today: from, fetchedAt: new Date().toISOString(), items: results });
}

// 60초 재사용 + 동시에 온 요청은 한 번만 조회
let memo = null;
let inflight = null;
function snapshot() {
  if (memo && Date.now() - memo.at < 60000) return Promise.resolve(memo.body);
  if (!inflight) {
    inflight = build().then(
      function (body) { memo = { at: Date.now(), body: body }; inflight = null; return body; },
      function (e) { inflight = null; throw e; }
    );
  }
  return inflight;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).send(JSON.stringify({ error: "GET only" }));
    return;
  }
  if (!(await isStaff(req))) {
    res.status(401).send(JSON.stringify({ error: "로그인이 필요합니다" }));
    return;
  }
  try {
    res.status(200).send(await snapshot());
  } catch (e) {
    res.status(502).send(JSON.stringify({ error: "조회 실패" }));
  }
};
