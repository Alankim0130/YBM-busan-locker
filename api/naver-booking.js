// ============================================================
// Vercel 서버리스 함수 — 네이버예약(강사 상담) 공개 현황 중계
// ------------------------------------------------------------
// 브라우저는 네이버에 직접 요청할 수 없어(CORS) 여기서 대신 읽는다.
// 첫토익·역전토익과 같은 방식: 공개 예약 페이지가 쓰는 GraphQL(hourlySchedule).
//   - 인증 불필요 · 조회 전용 · 예약자 정보 없음(칸마다 건수·정원뿐)
//   - 강사 목록은 아래 ITEMS 고정 → 임의 주소 중계 불가
//   - 응답은 60초 CDN 캐시 → 여러 PC가 열어도 네이버 호출은 분당 1회 수준
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

module.exports = async function handler(req, res) {
  const from = kstDay(0);
  const to = kstDay(DAYS_AHEAD);
  const results = await Promise.all(
    ITEMS.map(function (item) {
      return fetchItem(item, from, to).then(
        function (slots) { return { id: item.id, name: item.name, ok: true, slots: slots }; },
        function (e) { return { id: item.id, name: item.name, ok: false, error: String((e && e.message) || e) }; }
      );
    })
  );
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=30");
  res.status(200).send(JSON.stringify({ today: from, fetchedAt: new Date().toISOString(), items: results }));
};
