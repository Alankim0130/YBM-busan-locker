// ============================================================
// YBM 네이버 예약 알림 — 윈도우 프로그램 (.NET Framework 4.7.2, 윈도우 10/11 기본 탑재)
// ------------------------------------------------------------
// 파일 하나(exe)로 설치까지 한다:
//   받은 exe 실행 → 설치 확인 → %LOCALAPPDATA%\YBMNaverAlert 에 복사 · 자동 실행 등록 → 실행
// 실행 중에는 작업 표시줄 아이콘으로 상주하며 2분마다 네이버 예약을 확인하고,
// 예약이 추가·취소되면 화면 오른쪽 아래에 알림창을 띄운다.
//
// 명령줄 (점검용):
//   /uninstall [/quiet]  제거
//   /background          자동 실행(창 없이 시작)
//   /portable            설치하지 않고 바로 실행
//   /selftest            내장 점검
//   /endpoint:URL /datadir:경로 /interval:초 /scale:배율   (시험용)
// ============================================================
using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("YBM 네이버 예약 알림")]
[assembly: AssemblyDescription("서면 YBM 네이버 예약(강사 상담) 알림")]
[assembly: AssemblyCompany("서면 YBM")]
[assembly: AssemblyProduct("YBM 네이버 예약 알림")]
[assembly: AssemblyVersion("1.0.6.0")]
[assembly: AssemblyFileVersion("1.0.6.0")]
[assembly: TargetFramework(".NETFramework,Version=v4.7.2", FrameworkDisplayName = ".NET Framework 4.7.2")]

namespace YbmNaverAlert
{
    sealed class Options
    {
        public bool SelfTest, Uninstall, Quiet, Background, Installed, Portable;
        public string Endpoint, DataDir;
        public int? Interval;
        public float? Scale;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            foreach (var raw in args)
            {
                var a = raw.Trim();
                string key = a, val = null;
                int c = a.IndexOf(':');
                if (c > 0) { key = a.Substring(0, c); val = a.Substring(c + 1); }
                switch (key.ToLowerInvariant().Replace('-', '/'))
                {
                    case "/selftest": o.SelfTest = true; break;
                    case "/uninstall": o.Uninstall = true; break;
                    case "/quiet": o.Quiet = true; break;
                    case "/background": o.Background = true; break;
                    case "/installed": o.Installed = true; break;
                    case "/portable": o.Portable = true; break;
                    case "/endpoint":
                        {
                            // 시험용 — 이 PC 안의 주소(127.0.0.1·localhost)만 허용. 다른 서버로 바꿔 치기 못 하게
                            Uri u;
                            if (val != null && Uri.TryCreate(val, UriKind.Absolute, out u) && u.IsLoopback) o.Endpoint = val;
                            break;
                        }
                    case "/datadir": o.DataDir = val; break;
                    case "/interval":
                        {
                            int i;
                            if (int.TryParse(val, NumberStyles.Integer, CultureInfo.InvariantCulture, out i) && i >= 2) o.Interval = i;
                            break;
                        }
                    case "/scale":
                        {
                            float f;
                            if (float.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out f) && f >= 0.5f && f <= 4f) o.Scale = f;
                            break;
                        }
                }
            }
            return o;
        }
    }

    static class Program
    {
        public const string AppName = "YBM 네이버 예약 알림";
        public const string Version = "1.0.6";

        public static bool IsWindows { get { return Environment.OSVersion.Platform == PlatformID.Win32NT; } }

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [STAThread]
        static int Main(string[] args)
        {
            var o = Options.Parse(args);
            if (o.SelfTest) return SelfTest.Run();

            if (IsWindows) { try { SetProcessDPIAware(); } catch { } }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += (s, e) => Store.Log("오류: " + e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Store.Log("치명적 오류: " + e.ExceptionObject);

            Ui.Init(o.Scale);
            if (o.Uninstall) { Installer.Uninstall(o.Quiet); return 0; }   // 제거 중에는 기록 폴더를 다시 만들지 않는다

            Store.Dir = o.DataDir ?? Installer.Dir;
            try { Directory.CreateDirectory(Store.Dir); } catch { }
            if (o.Endpoint != null) Booking.Endpoint = o.Endpoint;
            if (IsWindows && !o.Portable && !Installer.RunningFromInstallDir()) return Installer.Install() ? 0 : 1;

            bool created;
            var mutex = new Mutex(true, Installer.MutexName, out created);
            if (!created)
            {
                Installer.Signal("Show");   // 이미 실행 중 → 그 프로그램의 현황 창을 연다
                mutex.Dispose();
                return 0;
            }
            try { Application.Run(new TrayApp(o)); }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { }
                mutex.Dispose();
            }
            return 0;
        }
    }
}
