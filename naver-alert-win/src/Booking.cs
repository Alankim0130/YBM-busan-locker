// ============================================================
// 네이버 예약(강사 상담) 공개 현황 조회 · 변동 비교
// ------------------------------------------------------------
// 첫토익·역전토익과 같은 방식: 공개 예약 페이지가 쓰는 GraphQL(hourlySchedule).
//   - 인증 불필요 · 조회 전용 · 예약자 정보 없음(칸마다 예약 수·정원뿐)
//   - 날짜는 시간대 표시 없이 보낸다(+09:00 을 붙이면 본문 오류)
//   - 응답 모양이 이상하면 0으로 메우지 않고 그 강사를 '실패'로 둔다
//     (0으로 메우면 예약이 전부 '취소'로 보이는 거짓 알림이 난다)
// 강사 목록은 사물함 웹(api/naver-booking.js)과 같다 — 바뀌면 둘 다 고친다.
// ============================================================
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace YbmNaverAlert
{
    sealed class Item
    {
        public readonly string Id, Name;
        public Item(string id, string name) { Id = id; Name = name; }
    }

    // 예약 칸 하나 — T 는 한국 시각 "yyyy-MM-dd HH:mm"
    sealed class Slot
    {
        public string T;
        public int B;      // 예약 수 (bookingCount)
        public int S;      // 정원 (stock)
        public bool Open;  // 판매일·영업일 여부
    }

    sealed class ItemResult
    {
        public Item Item;
        public bool Ok;
        public string Error;
        public List<Slot> Slots;
    }

    sealed class Change
    {
        public DateTime DetectedAt;   // 감지 시각(한국 시각)
        public bool Booked;           // true = 예약이 늘어남, false = 줄어듦(취소)
        public string ItemId, Name, T;
        public int Diff, B, S;
    }

    static class Kst
    {
        public static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        static readonly string[] Week = { "일", "월", "화", "수", "목", "금", "토" };

        // 한국 벽시계 시각 (PC 시간대와 무관)
        public static DateTime Now { get { return DateTime.UtcNow.AddHours(9); } }
        public static string Ymd(DateTime d) { return d.ToString("yyyy-MM-dd", Inv); }
        public static string Stamp(DateTime d) { return d.ToString("yyyy-MM-dd HH:mm", Inv); }

        // "2026-10-15" → "10/15(목)"
        public static string Day(string ymd)
        {
            var d = DateTime.ParseExact(ymd, "yyyy-MM-dd", Inv);
            return d.Month + "/" + d.Day + "(" + Week[(int)d.DayOfWeek] + ")";
        }

        // "2026-10-15 15:00" → "10/15(목) 15:00"
        public static string When(string t) { return Day(t.Substring(0, 10)) + " " + t.Substring(11, 5); }
    }

    static class Booking
    {
        public const int BusinessTypeId = 12;
        public const string BusinessId = "459658";
        public static readonly Item[] Items =
        {
            new Item("4139011", "역전토익"),
            new Item("6523641", "벨라토익"),
            new Item("3736463", "첫토익"),
            new Item("6247491", "독한토익"),
            new Item("6108857", "밀착토익"),
            new Item("7270580", "브라이언오픽"),
        };

        // 예약을 여는 기간보다 길어야 먼 날짜 예약도 변동으로 잡힌다
        public const int DaysAhead = 60;
        public static string Endpoint = "https://m.booking.naver.com/graphql";

        const string Query = "query hourlySchedule($scheduleParams: ScheduleParams) { schedule(input: $scheduleParams) { bizItemSchedule { hourly { unitStartTime bookingCount stock isUnitSaleDay isUnitBusinessDay } } } }";
        const string UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

        static bool tlsSet;

        // 연결 설정: TLS 1.2 보장(오래된 .NET 기본값은 TLS 1.0), 6명 동시 조회, 'Expect: 100-continue' 끔
        static void EnsureNet()
        {
            if (tlsSet) return;
            tlsSet = true;
            try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; } catch { }
            ServicePointManager.Expect100Continue = false;
            if (ServicePointManager.DefaultConnectionLimit < 8) ServicePointManager.DefaultConnectionLimit = 8;
        }

        public static string PageUrl(string itemId, string day)
        {
            var u = "https://m.booking.naver.com/booking/12/bizes/" + BusinessId + "/items/" + itemId;
            return day == null ? u : u + "?startDateTime=" + day + "T00%3A00%3A00%2B09%3A00";
        }

        public static string RequestJson(Item it, string from, string to)
        {
            var p = new Dictionary<string, object>
            {
                { "businessTypeId", BusinessTypeId },
                { "businessId", BusinessId },
                { "bizItemId", it.Id },
                { "startDateTime", from + "T00:00:00" },
                { "endDateTime", to + "T23:59:59" },
                { "fixedTime", true },
            };
            var body = new Dictionary<string, object>
            {
                { "operationName", "hourlySchedule" },
                { "query", Query },
                { "variables", new Dictionary<string, object> { { "scheduleParams", p } } },
            };
            return new JavaScriptSerializer().Serialize(body);
        }

        public static async Task<ItemResult> FetchAsync(Item it, string from, string to)
        {
            var r = new ItemResult { Item = it };
            try
            {
                r.Slots = Parse(await PostAsync(Endpoint, RequestJson(it, from, to), PageUrl(it.Id, null), 25000).ConfigureAwait(false));
                r.Ok = true;
            }
            catch (Exception e)
            {
                r.Ok = false;
                r.Error = Describe(e);
            }
            return r;
        }

        // HttpWebRequest(System.dll)만 쓴다 — 윈도우 10 어느 버전의 .NET 에도 있다.
        // 비동기 호출에는 Timeout 이 안 걸리므로 직접 끊는다.
        static async Task<string> PostAsync(string url, string json, string referer, int timeoutMs)
        {
            EnsureNet();
            var req = (HttpWebRequest)WebRequest.Create(url);
            if (req.Proxy != null) req.Proxy.Credentials = CredentialCache.DefaultCredentials;  // 회사 프록시 대응
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Accept = "*/*";
            req.UserAgent = UA;
            req.Referer = referer;
            req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            req.KeepAlive = true;
            var body = Encoding.UTF8.GetBytes(json);
            req.ContentLength = body.Length;

            var work = SendAsync(req, body);
            if (await Task.WhenAny(work, Task.Delay(timeoutMs)).ConfigureAwait(false) != work)
            {
                try { req.Abort(); } catch { }
                throw new TimeoutException("시간 초과");
            }
            return await work.ConfigureAwait(false);
        }

        static async Task<string> SendAsync(HttpWebRequest req, byte[] body)
        {
            using (var rs = await req.GetRequestStreamAsync().ConfigureAwait(false))
                await rs.WriteAsync(body, 0, body.Length).ConfigureAwait(false);
            HttpWebResponse res;
            try { res = (HttpWebResponse)await req.GetResponseAsync().ConfigureAwait(false); }
            catch (WebException we)
            {
                var er = we.Response as HttpWebResponse;
                if (er == null) throw;
                using (er) throw new Exception("네이버 응답 " + (int)er.StatusCode);
            }
            using (res)
            using (var st = res.GetResponseStream())
            using (var rd = new StreamReader(st, Encoding.UTF8))
            {
                // 정상 응답은 수십 KB — 비정상적으로 큰 응답은 읽다가 끊는다(메모리 보호)
                var sb = new StringBuilder();
                var buf = new char[16384];
                int n;
                while ((n = await rd.ReadAsync(buf, 0, buf.Length).ConfigureAwait(false)) > 0)
                {
                    sb.Append(buf, 0, n);
                    if (sb.Length > MaxResponseChars) throw new Exception("응답이 너무 큼");
                }
                return sb.ToString();
            }
        }

        const int MaxResponseChars = 4 * 1024 * 1024;

        static string Describe(Exception e)
        {
            if (e is TimeoutException || e is TaskCanceledException) return "시간 초과";
            var inner = e;
            while (inner.InnerException != null) inner = inner.InnerException;  // 연결 오류는 원인이 안쪽에 있다
            return Cut(inner.Message, 160);
        }

        static string Cut(string s, int n) { return s.Length > n ? s.Substring(0, n) : s; }

        static readonly Regex TimeRe = new Regex(@"^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2})", RegexOptions.CultureInvariant);

        // 응답 → 칸 목록. 하나라도 이상하면 통째로 거절(예외)
        public static List<Slot> Parse(string text)
        {
            object root;
            try { root = new JavaScriptSerializer { MaxJsonLength = MaxResponseChars, RecursionLimit = 32 }.DeserializeObject(text); }
            catch { throw new Exception("응답이 JSON 이 아님"); }
            var o = root as IDictionary<string, object>;
            if (o == null) throw new Exception("응답이 JSON 객체가 아님");

            var errors = Get(o, "errors") as IList;
            if (errors != null && errors.Count > 0)
            {
                var msg = Get(errors[0], "message") as string;
                throw new Exception("네이버 오류: " + Cut(msg ?? "알 수 없음", 160));
            }

            var hourly = Get(Get(Get(Get(o, "data"), "schedule"), "bizItemSchedule"), "hourly") as IList;
            if (hourly == null) throw new Exception("hourly 목록 없음 (응답 모양이 바뀌었을 수 있음)");

            var byTime = new Dictionary<string, Slot>();
            var list = new List<Slot>();
            for (int i = 0; i < hourly.Count; i++)
            {
                var h = hourly[i] as IDictionary<string, object>;
                if (h == null) throw new Exception(i + "번째 칸이 객체가 아님");
                var ts = Get(h, "unitStartTime") as string;
                var m = ts == null ? null : TimeRe.Match(ts);
                if (m == null || !m.Success) throw new Exception(i + "번째 칸 시각 오류");
                int b, s;
                if (!Count(Get(h, "bookingCount"), out b)) throw new Exception(i + "번째 칸 bookingCount 오류");
                if (!Count(Get(h, "stock"), out s)) throw new Exception(i + "번째 칸 stock 오류");
                bool open = !IsFalse(Get(h, "isUnitSaleDay")) && !IsFalse(Get(h, "isUnitBusinessDay"));
                string t = m.Groups[1].Value + " " + m.Groups[2].Value;

                Slot same;
                if (byTime.TryGetValue(t, out same)) { same.B += b; same.S += s; same.Open |= open; }  // 같은 시각이 또 오면 합친다
                else { var sl = new Slot { T = t, B = b, S = s, Open = open }; byTime[t] = sl; list.Add(sl); }
            }
            list.Sort((x, y) => string.CompareOrdinal(x.T, y.T));
            return list;
        }

        static object Get(object o, string k)
        {
            var d = o as IDictionary<string, object>;
            object v;
            return d != null && d.TryGetValue(k, out v) ? v : null;
        }

        static bool IsFalse(object v) { return v is bool && !(bool)v; }

        static bool Count(object v, out int n)
        {
            n = 0;
            if (v is int) n = (int)v;
            else if (v is long) { var l = (long)v; if (l < 0 || l >= 10000) return false; n = (int)l; }
            else if (v is decimal) { var d = (decimal)v; if (d != decimal.Truncate(d) || d < 0 || d >= 10000) return false; n = (int)d; }
            else if (v is double) { var d = (double)v; if (d != Math.Floor(d) || d < 0 || d >= 10000) return false; n = (int)d; }
            else return false;
            return n >= 0 && n < 10000;
        }

        // 사라진 칸을 취소로 보지 않는 '곧 시작할 칸' 범위 — 네이버는 시작이 가까운 칸을 예약이 있어도 먼저 닫는다
        public const int VanishGuardMinutes = 60;

        // 직전 기록(prev)과 비교해 변동 목록을 만들고, 다음 기록을 next 에 채운다. **오늘 칸만** 알린다.
        //   - prev == null(첫 실행): 기준선만 저장, 알림 없음
        //   - 오늘이 아닌 칸 · 지나간 칸: 기록만 하고 알리지 않음
        //   - 예약 수가 늘거나 줄면: 예약 / 취소
        //   - 목록에 없던 칸이 예약된 채 나타나면: 예약 (예약을 더 받지 않는 시간대는 비어 있으면 목록에 안 나온다)
        //   - 예약이 있던 칸이 목록에서 사라지면: 한 번 더 확인해서(2분 뒤) 그래도 없으면 취소
        //     (기록에 "?" 를 붙여 한 번 보류 — 네이버가 잠깐 이상한 목록을 줘도 거짓 취소를 내지 않게)
        //     시작까지 1시간이 안 남은 칸은 네이버가 먼저 닫을 수 있어 취소로 보지 않는다
        //   - 조회 실패한 강사: 직전 값을 그대로 넘기고 비교하지 않음
        public static List<Change> Diff(Dictionary<string, int> prev, IList<ItemResult> results, string nowKst, Dictionary<string, int> next, DateTime detectedAt)
        {
            var changes = new List<Change>();
            string today = nowKst.Substring(0, 10);
            string soon = Kst.Stamp(DateTime.ParseExact(nowKst, "yyyy-MM-dd HH:mm", Kst.Inv).AddMinutes(VanishGuardMinutes));
            foreach (var r in results)
            {
                string prefix = r.Item.Id + "|";
                string pendingPrefix = "?" + prefix;
                if (!r.Ok)
                {
                    if (prev != null)
                        foreach (var kv in prev)
                            if (kv.Key.StartsWith(prefix, StringComparison.Ordinal) || kv.Key.StartsWith(pendingPrefix, StringComparison.Ordinal))
                                next[kv.Key] = kv.Value;
                    continue;
                }

                bool seenBefore = false;
                if (prev != null)
                    foreach (var key in prev.Keys)
                        if (key.StartsWith(prefix, StringComparison.Ordinal) || key.StartsWith(pendingPrefix, StringComparison.Ordinal)) { seenBefore = true; break; }

                var present = new HashSet<string>();
                foreach (var s in r.Slots)
                {
                    string k = prefix + s.T;
                    present.Add(k);
                    next[k] = s.B;
                    if (prev == null) continue;
                    if (!s.T.StartsWith(today, StringComparison.Ordinal) || string.CompareOrdinal(s.T, nowKst) < 0) continue;   // 오늘 · 아직 안 지난 칸만
                    int old;
                    if (prev.TryGetValue(k, out old) || prev.TryGetValue("?" + k, out old))
                    {
                        if (old != s.B) changes.Add(MakeChange(r.Item, s.T, s.B > old, Math.Abs(s.B - old), s.B, s.S, detectedAt));
                    }
                    else if (seenBefore && s.B > 0)
                    {
                        changes.Add(MakeChange(r.Item, s.T, true, s.B, s.B, s.S, detectedAt));
                    }
                }

                if (prev == null) continue;
                foreach (var kv in prev)
                {
                    bool pending = kv.Key.StartsWith(pendingPrefix, StringComparison.Ordinal);
                    if (!pending && !kv.Key.StartsWith(prefix, StringComparison.Ordinal)) continue;
                    string k = pending ? kv.Key.Substring(1) : kv.Key;
                    if (present.Contains(k) || kv.Value <= 0) continue;
                    string t = k.Substring(prefix.Length);
                    if (!t.StartsWith(today, StringComparison.Ordinal) || string.CompareOrdinal(t, soon) <= 0) continue;   // 오늘 · 1시간 넘게 남은 칸만
                    if (!pending) next["?" + k] = kv.Value;                                              // 처음 사라짐 → 보류
                    else changes.Add(MakeChange(r.Item, t, false, kv.Value, 0, 0, detectedAt));          // 두 번 연속 없음 → 취소
                }
            }
            return changes;
        }

        static Change MakeChange(Item it, string t, bool booked, int diff, int b, int s, DateTime at)
        {
            return new Change { DetectedAt = at, Booked = booked, ItemId = it.Id, Name = it.Name, T = t, Diff = diff, B = b, S = s };
        }
    }
}
