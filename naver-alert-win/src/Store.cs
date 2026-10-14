// 이 PC에 남기는 기록 — %LOCALAPPDATA%\YBMNaverAlert
//   snap.txt   : 칸마다 직전 예약 수 (변동 비교 기준)
//   events.txt : 감지한 예약·취소 이력 (최근 200건)
//   log.txt    : 오류·동작 기록
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace YbmNaverAlert
{
    static class Store
    {
        public static string Dir;
        static readonly Encoding Utf8 = new UTF8Encoding(false);
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        static string P(string name) { return Path.Combine(Dir, name); }

        public static Dictionary<string, int> LoadSnap()
        {
            var path = P("snap.txt");
            if (!File.Exists(path)) return null;
            try
            {
                var d = new Dictionary<string, int>();
                foreach (var line in File.ReadAllLines(path, Utf8))
                {
                    int i = line.LastIndexOf('\t');
                    int v;
                    if (i > 0 && int.TryParse(line.Substring(i + 1), NumberStyles.Integer, Inv, out v)) d[line.Substring(0, i)] = v;
                }
                return d;
            }
            catch (Exception e)
            {
                Log("직전 기록 읽기 실패 — 기준선부터 다시 시작: " + e.Message);
                return null;
            }
        }

        public static void SaveSnap(Dictionary<string, int> d)
        {
            WriteAtomic(P("snap.txt"), d.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => kv.Key + "\t" + kv.Value.ToString(Inv)));
        }

        public static List<Change> LoadEvents()
        {
            var list = new List<Change>();
            var path = P("events.txt");
            if (!File.Exists(path)) return list;
            try
            {
                foreach (var line in File.ReadAllLines(path, Utf8))
                {
                    var f = line.Split('\t');
                    if (f.Length < 8) continue;
                    DateTime at;
                    if (!DateTime.TryParseExact(f[0], "yyyy-MM-dd HH:mm:ss", Inv, DateTimeStyles.None, out at)) continue;
                    int diff, b, s;
                    if (!int.TryParse(f[5], NumberStyles.Integer, Inv, out diff) || !int.TryParse(f[6], NumberStyles.Integer, Inv, out b) || !int.TryParse(f[7], NumberStyles.Integer, Inv, out s)) continue;
                    if (f[4].Length < 16) continue;
                    list.Add(new Change { DetectedAt = at, Booked = f[1] == "1", ItemId = f[2], Name = f[3], T = f[4], Diff = diff, B = b, S = s });
                }
            }
            catch (Exception e) { Log("이력 읽기 실패: " + e.Message); }
            return list;
        }

        public static void SaveEvents(List<Change> list)
        {
            try
            {
                WriteAtomic(P("events.txt"), list.Take(200).Select(c => string.Join("\t", new[]
                {
                    c.DetectedAt.ToString("yyyy-MM-dd HH:mm:ss", Inv), c.Booked ? "1" : "0", c.ItemId, c.Name, c.T,
                    c.Diff.ToString(Inv), c.B.ToString(Inv), c.S.ToString(Inv),
                })));
            }
            catch (Exception e) { Log("이력 저장 실패: " + e.Message); }
        }

        static void WriteAtomic(string path, IEnumerable<string> lines)
        {
            var tmp = path + ".tmp";
            File.WriteAllLines(tmp, lines, Utf8);
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        public static void Log(string msg)
        {
            try
            {
                if (Dir == null) return;
                Directory.CreateDirectory(Dir);
                var path = P("log.txt");
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", Inv) + "  " + msg + Environment.NewLine, Utf8);
                var fi = new FileInfo(path);
                if (fi.Length > 256 * 1024)
                {
                    var keep = File.ReadAllLines(path, Utf8);
                    File.WriteAllLines(path, keep.Skip(Math.Max(0, keep.Length - 500)), Utf8);
                }
            }
            catch { }
        }
    }
}
