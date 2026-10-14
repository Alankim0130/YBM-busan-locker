// 강사님께 보내는 카톡 메시지 문구 (복사 버튼)
//   명단:  <첫토익 상담예약자 명단>
//          16:00 1명
//          16:30 2명
//   변동:  첫토익 16:00 예약자 취소하셨습니다.
//          첫토익 16:30 상담예약 있습니다.
// 오늘이 아닌 날은 시각 앞에 날짜를 붙인다 (예: 첫토익 10/15(목) 16:30 …)
// 사물함 웹(app.js 의 nbSummaryText / nbChangeText)과 같은 문구 — 바꾸면 둘 다 고친다.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace YbmNaverAlert
{
    static class Msg
    {
        const string NL = "\r\n";

        static string When(string t, string today)
        {
            return t.StartsWith(today, StringComparison.Ordinal) ? t.Substring(11, 5) : Kst.When(t);
        }

        public static string Change(Change c, string today)
        {
            string n = c.Diff > 1 ? c.Diff + "명 " : "";
            return c.Booked
                ? c.Name + " " + When(c.T, today) + " 상담예약 " + n + "있습니다."
                : c.Name + " " + When(c.T, today) + " 예약자 " + n + "취소하셨습니다.";
        }

        public static string Summary(string name, string day, string today, IEnumerable<Slot> slots)
        {
            var sb = new StringBuilder();
            sb.Append('<').Append(name).Append(day == today ? "" : " " + Kst.Day(day)).Append(" 상담예약자 명단>");
            var booked = (slots ?? Enumerable.Empty<Slot>())
                .Where(s => s.B > 0 && s.T.StartsWith(day, StringComparison.Ordinal))
                .OrderBy(s => s.T, StringComparer.Ordinal)
                .ToList();
            if (booked.Count == 0) sb.Append(NL).Append("예약 없음");
            foreach (var s in booked) sb.Append(NL).Append(s.T.Substring(11, 5)).Append(' ').Append(s.B).Append("명");
            return sb.ToString();
        }

        // 클립보드에 넣기 — 다른 프로그램이 잠깐 붙잡고 있으면 몇 번 다시 시도
        public static bool Copy(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            try
            {
                Clipboard.SetDataObject(text, true, 5, 100);
                return true;
            }
            catch (Exception e)
            {
                Store.Log("복사 실패: " + e.Message);
                return false;
            }
        }
    }
}
