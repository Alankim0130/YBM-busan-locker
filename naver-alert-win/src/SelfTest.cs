// 내장 점검 — YBMNaverAlert.exe /selftest
// 네이버 응답 해석·변동 비교·기록 저장이 의도대로 되는지 확인한다(네트워크 불필요).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace YbmNaverAlert
{
    static class SelfTest
    {
        static int fail, pass;

        static void Ok(bool cond, string name)
        {
            if (cond) pass++;
            else { fail++; Console.WriteLine("FAIL  " + name); }
        }

        static string Throws(Action a)
        {
            try { a(); return null; }
            catch (Exception e) { return e.Message; }
        }

        static string H(string t, object b, object s, string extra = "")
        {
            return "{\"unitStartTime\":\"" + t + "\",\"bookingCount\":" + b + ",\"stock\":" + s + extra + "}";
        }

        static string Body(params string[] slots)
        {
            return "{\"data\":{\"schedule\":{\"bizItemSchedule\":{\"hourly\":[" + string.Join(",", slots) + "]}}}}";
        }

        static ItemResult R(Item it, params Slot[] slots) { return new ItemResult { Item = it, Ok = true, Slots = slots.ToList() }; }
        static Slot Sl(string t, int b) { return new Slot { T = t, B = b, S = 1, Open = true }; }

        public static int Run()
        {
            // ── 응답 해석
            var list = Booking.Parse(Body(
                H("2026-10-15 16:00:00", 0, 1, ",\"isUnitSaleDay\":true,\"isUnitBusinessDay\":true"),
                H("2026-10-15 15:00:00", 1, 1),
                H("2026-10-15 15:00:00", 1, 1),
                H("2026-10-16 10:00:00", 0, 1, ",\"isUnitBusinessDay\":false")));
            Ok(list.Count == 3, "parse: 같은 시각 합치기 → 3칸");
            Ok(list[0].T == "2026-10-15 15:00" && list[0].B == 2 && list[0].S == 2, "parse: 시각순 정렬·합산");
            Ok(list[1].T == "2026-10-15 16:00" && list[1].B == 0 && list[1].Open, "parse: 빈 칸");
            Ok(!list[2].Open, "parse: 영업일 아님");

            var e1 = Throws(() => Booking.Parse("{\"errors\":[{\"message\":\"Wrong type\"}]}"));
            Ok(e1 != null && e1.Contains("Wrong type"), "parse: 네이버 오류 → 실패");
            Ok(Throws(() => Booking.Parse(Body("{\"unitStartTime\":\"2026-10-15 15:00:00\",\"stock\":1}"))) != null, "parse: bookingCount 없음 → 실패(0으로 메우지 않음)");
            Ok(Throws(() => Booking.Parse(Body(H("2026-10-15 15:00:00", "1.5", 1)))) != null, "parse: 소수 → 실패");
            Ok(Throws(() => Booking.Parse(Body(H("2026-10-15 15:00:00", "\"1\"", 1)))) != null, "parse: 문자열 숫자 → 실패");
            Ok(Throws(() => Booking.Parse(Body(H("어제", 1, 1)))) != null, "parse: 시각 오류 → 실패");
            Ok(Throws(() => Booking.Parse("<html>")) != null, "parse: JSON 아님 → 실패");
            Ok(Throws(() => Booking.Parse("{\"data\":{}}")) != null, "parse: hourly 없음 → 실패");
            Ok(Booking.Parse(Body()).Count == 0, "parse: 빈 목록 허용");

            // ── 요청 본문: 시간대 표시 없이
            var req = Booking.RequestJson(Booking.Items[0], "2026-10-14", "2026-12-13");
            Ok(req.Contains("\"startDateTime\":\"2026-10-14T00:00:00\"") && req.Contains("\"endDateTime\":\"2026-12-13T23:59:59\"") && !req.Contains("+09"), "request: 날짜 형식");
            Ok(req.Contains("\"bizItemId\":\"4139011\"") && req.Contains("\"businessTypeId\":12") && req.Contains("\"businessId\":\"459658\"") && req.Contains("\"fixedTime\":true"), "request: 업체·상품 번호");
            Ok(req.Contains("\"operationName\":\"hourlySchedule\""), "request: operationName");

            // ── 변동 비교
            var A = Booking.Items[0];
            var B = Booking.Items[1];
            var now = "2026-10-15 12:00";
            var at = new DateTime(2026, 10, 15, 12, 0, 0);
            var next0 = new Dictionary<string, int>();
            var ch0 = Booking.Diff(null, new[] { R(A, Sl("2026-10-15 15:00", 1)) }, now, next0, at);
            Ok(ch0.Count == 0 && next0.Count == 1, "diff: 첫 실행은 기준선만");

            var prev = new Dictionary<string, int>
            {
                { A.Id + "|2026-10-15 15:00", 0 },
                { A.Id + "|2026-10-15 16:00", 1 },
                { A.Id + "|2026-10-15 09:00", 1 },  // 지난 칸
                { A.Id + "|2026-10-16 10:00", 0 },  // 내일 칸
                { B.Id + "|2026-10-15 15:00", 0 },
                { "?" + B.Id + "|2026-10-15 18:00", 1 },  // 보류 중인 사라진 칸
            };
            var next = new Dictionary<string, int>();
            var results = new List<ItemResult>
            {
                R(A, Sl("2026-10-15 09:00", 0), Sl("2026-10-15 15:00", 1), Sl("2026-10-15 16:00", 0), Sl("2026-10-15 17:00", 1), Sl("2026-10-16 10:00", 1)),
                new ItemResult { Item = B, Ok = false, Error = "x" },
            };
            var ch = Booking.Diff(prev, results, now, next, at);
            Ok(ch.Count == 3, "diff: 오늘 변동 3건 (지난 칸·내일 칸 제외)");
            Ok(ch.Any(c => c.Booked && c.T == "2026-10-15 15:00" && c.Name == A.Name && c.Diff == 1), "diff: 예약 감지");
            Ok(ch.Any(c => !c.Booked && c.T == "2026-10-15 16:00"), "diff: 취소 감지");
            Ok(ch.Any(c => c.Booked && c.T == "2026-10-15 17:00" && c.Diff == 1), "diff: 목록에 없던 칸이 예약된 채 나타나면 예약");
            Ok(!ch.Any(c => c.T.StartsWith("2026-10-16")) && next[A.Id + "|2026-10-16 10:00"] == 1, "diff: 내일 칸은 기록만, 알림 없음");
            Ok(next[B.Id + "|2026-10-15 15:00"] == 0 && next["?" + B.Id + "|2026-10-15 18:00"] == 1, "diff: 조회 실패한 강사는 직전 값(보류 포함) 유지");

            // 사라진 칸 → 한 번 보류 → 다음에도 없으면 취소
            var C = Booking.Items[2];
            var p1 = new Dictionary<string, int> { { C.Id + "|2026-10-15 18:00", 1 }, { C.Id + "|2026-10-15 19:00", 0 }, { C.Id + "|2026-10-15 12:30", 1 }, { C.Id + "|2026-10-16 18:00", 1 } };
            var n1 = new Dictionary<string, int>();
            var c1 = Booking.Diff(p1, new[] { R(C, Sl("2026-10-15 20:00", 0)) }, now, n1, at);
            Ok(c1.Count == 0 && n1.ContainsKey("?" + C.Id + "|2026-10-15 18:00"), "vanish: 처음 사라지면 보류(알림 없음)");
            Ok(!n1.ContainsKey("?" + C.Id + "|2026-10-15 19:00"), "vanish: 예약 없던 칸이 사라지면 무시");
            Ok(!n1.ContainsKey("?" + C.Id + "|2026-10-15 12:30"), "vanish: 시작 1시간 안 남은 칸은 무시");
            Ok(!n1.ContainsKey("?" + C.Id + "|2026-10-16 18:00"), "vanish: 내일 칸은 무시");
            var n2 = new Dictionary<string, int>();
            var c2 = Booking.Diff(n1, new[] { R(C, Sl("2026-10-15 20:00", 0)) }, "2026-10-15 12:02", n2, at);
            Ok(c2.Count == 1 && !c2[0].Booked && c2[0].T == "2026-10-15 18:00" && c2[0].Diff == 1 && !n2.ContainsKey("?" + C.Id + "|2026-10-15 18:00"), "vanish: 두 번 연속 없으면 취소");
            var n3 = new Dictionary<string, int>();
            var c3 = Booking.Diff(n1, new[] { R(C, Sl("2026-10-15 18:00", 1), Sl("2026-10-15 20:00", 0)) }, "2026-10-15 12:02", n3, at);
            Ok(c3.Count == 0 && n3[C.Id + "|2026-10-15 18:00"] == 1 && !n3.ContainsKey("?" + C.Id + "|2026-10-15 18:00"), "vanish: 다시 나타나면 보류 해제(알림 없음)");
            var n4 = new Dictionary<string, int>();
            var c4 = Booking.Diff(n1, new[] { R(C, Sl("2026-10-15 18:00", 0)) }, "2026-10-15 12:02", n4, at);
            Ok(c4.Count == 1 && !c4[0].Booked && c4[0].T == "2026-10-15 18:00", "vanish: 0명으로 다시 나타나면 취소");
            var n5 = new Dictionary<string, int>();
            var c5 = Booking.Diff(new Dictionary<string, int> { { A.Id + "|2026-10-15 15:00", 0 } }, new[] { R(C, Sl("2026-10-15 18:00", 1)) }, now, n5, at);
            Ok(c5.Count == 0, "diff: 처음 보는 강사의 예약은 기준선(알림 없음)");

            // ── 보안: 여는 주소·시험용 옵션 제한
            Ok(Ui.IsAllowedUrl(Booking.PageUrl("4139011", "2026-10-15")), "url: 네이버 예약 페이지 허용");
            Ok(!Ui.IsAllowedUrl("http://m.booking.naver.com/booking/12"), "url: http 차단");
            Ok(!Ui.IsAllowedUrl("https://m.booking.naver.com.evil.com/x"), "url: 비슷한 도메인 차단");
            Ok(!Ui.IsAllowedUrl("https://m.booking.naver.com:8443/x"), "url: 다른 포트 차단");
            Ok(!Ui.IsAllowedUrl("file:///C:/Windows/System32/calc.exe") && !Ui.IsAllowedUrl("calc.exe") && !Ui.IsAllowedUrl(null), "url: 파일·프로그램 차단");
            Ok(Options.Parse(new[] { "/endpoint:https://evil.example/graphql" }).Endpoint == null, "opt: 외부 endpoint 거부");
            Ok(Options.Parse(new[] { "/endpoint:http://127.0.0.1:8799/graphql" }).Endpoint != null, "opt: 이 PC endpoint 허용(시험용)");
            Ok(Throws(() => Booking.Parse(new string('[', 200) + new string(']', 200))) != null, "parse: 깊은 중첩 거절");

            // ── 카톡 메시지 문구
            var today = "2026-10-15";
            var mk = new Func<bool, string, int, Change>((bk, t, d) => new Change { Booked = bk, Name = "첫토익", T = t, Diff = d, B = 1, S = 1 });
            Ok(Msg.Change(mk(false, "2026-10-15 16:00", 1), today) == "첫토익 16:00 예약자 취소하셨습니다.", "msg: 오늘 취소");
            Ok(Msg.Change(mk(true, "2026-10-15 16:30", 1), today) == "첫토익 16:30 상담예약 있습니다.", "msg: 오늘 예약");
            Ok(Msg.Change(mk(true, "2026-10-16 16:30", 2), today) == "첫토익 10/16(금) 16:30 상담예약 2명 있습니다.", "msg: 다른 날 · 2명");
            Ok(Msg.Change(mk(false, "2026-10-16 16:00", 2), today) == "첫토익 10/16(금) 16:00 예약자 2명 취소하셨습니다.", "msg: 다른 날 취소 2명");
            var daySlots = new List<Slot> { Sl("2026-10-15 16:30", 2), Sl("2026-10-15 16:00", 1), Sl("2026-10-15 17:00", 0), Sl("2026-10-16 10:00", 1) };
            Ok(Msg.Summary("첫토익", today, today, daySlots) == "<첫토익 상담예약자 명단>\r\n16:00 1명\r\n16:30 2명", "msg: 오늘 명단(시각순·빈 칸 제외)");
            Ok(Msg.Summary("첫토익", "2026-10-16", today, daySlots) == "<첫토익 10/16(금) 상담예약자 명단>\r\n10:00 1명", "msg: 다른 날 명단");
            Ok(Msg.Summary("벨라토익", today, today, new List<Slot>()) == "<벨라토익 상담예약자 명단>\r\n예약 없음", "msg: 예약 없음");

            // ── 날짜 표시
            Ok(Kst.When("2026-10-15 15:00") == "10/15(목) 15:00", "kst: 요일 표시");
            Ok(Kst.Day("2026-10-18") == "10/18(일)", "kst: 일요일");

            // ── 기록 저장·읽기
            var dir = Path.Combine(Path.GetTempPath(), "ybm-selftest-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            var old = Store.Dir;
            Store.Dir = dir;
            try
            {
                Ok(Store.LoadSnap() == null, "store: 기록 없음 → null");
                Store.SaveSnap(next);
                var back = Store.LoadSnap();
                Ok(back != null && back.Count == next.Count && back.All(kv => next[kv.Key] == kv.Value), "store: snap 왕복");
                Store.SaveEvents(ch);
                var evs = Store.LoadEvents();
                Ok(evs.Count == ch.Count && evs[0].Name == ch[0].Name && evs[0].T == ch[0].T && evs[0].Booked == ch[0].Booked && evs[0].DetectedAt == at, "store: 이력 왕복");
            }
            finally
            {
                Store.Dir = old;
                try { Directory.Delete(dir, true); } catch { }
            }

            Console.WriteLine((fail == 0 ? "OK" : "FAILED") + "  " + pass + " passed, " + fail + " failed");
            return fail == 0 ? 0 : 1;
        }
    }
}
