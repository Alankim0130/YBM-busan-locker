// 설치 · 업데이트 · 제거 (관리자 권한 없이, 현재 사용자에게만)
//   설치 위치 : %LOCALAPPDATA%\YBMNaverAlert\YBMNaverAlert.exe
//   자동 실행 : HKCU\...\Run\YBMNaverAlert  ("...exe" /background)
//   제거 등록 : HKCU\...\Uninstall\YBMNaverAlert  (설정 → 앱 → 설치된 앱 에서 제거 가능)
//   시작 메뉴 : 'YBM 네이버 예약 알림' 바로가기
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace YbmNaverAlert
{
    static class Installer
    {
        public static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YBMNaverAlert");
        public static string ExePath { get { return Path.Combine(Dir, "YBMNaverAlert.exe"); } }
        public const string MutexName = @"Local\YBMNaverAlert.App";
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValue = "YBMNaverAlert";
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\YBMNaverAlert";

        static string StartMenuLink
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Program.AppName + ".lnk"); }
        }

        [DllImport("user32.dll")]
        static extern bool AllowSetForegroundWindow(int pid);

        public static bool RunningFromInstallDir()
        {
            try { return string.Equals(Path.GetFullPath(Application.ExecutablePath), Path.GetFullPath(ExePath), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        public static bool Install()
        {
            string self = Application.ExecutablePath;
            bool exists = File.Exists(ExePath);
            if (exists && SameFile(self, ExePath))
            {
                // 같은 버전이 이미 설치됨 → 설치 과정 없이 실행(이미 실행 중이면 현황 창만 연다)
                if (!Signal("Show")) Start("");
                return true;
            }

            string q = exists
                ? "이미 설치되어 있습니다.\n\n이 파일로 다시 설치(업데이트)할까요?"
                : "YBM 네이버 예약 알림을 이 PC에 설치할까요?\n\n· 윈도우를 켜면 자동으로 실행됩니다.\n· 강사 상담 예약이 추가되거나 취소되면 화면 오른쪽 아래에 알려 드립니다.\n· 관리자 권한은 필요 없습니다.";
            if (MessageBox.Show(q, Program.AppName + " 설치", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return false;

            try
            {
                StopRunning();
                RemoveOldPowerShellVersion();
                CleanTempLeftovers();
                Directory.CreateDirectory(Dir);
                CopyFresh(self, ExePath);
                SetAutoStart(true);
                RegisterUninstall();
                CreateStartMenuLink();
                Store.Log("설치 완료 v" + Program.Version);
                Start("/installed");
                return true;
            }
            catch (Exception e)
            {
                Store.Log("설치 실패: " + e);
                MessageBox.Show("설치하지 못했습니다.\n\n" + e.Message, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
        }

        public static void Uninstall(bool quiet)
        {
            if (!quiet && MessageBox.Show("YBM 네이버 예약 알림을 제거할까요?\n\n제거하면 더 이상 예약 알림이 오지 않습니다.", Program.AppName + " 제거", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            StopRunning();
            try { SetAutoStart(false); } catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
            try { if (File.Exists(StartMenuLink)) File.Delete(StartMenuLink); } catch { }
            RemoveOldPowerShellVersion();

            // 실행 중인 exe 는 지울 수 없지만 옮길 수는 있다 → 임시 폴더로 옮긴 뒤 설치 폴더를 지운다.
            // (명령 프롬프트를 띄워 스스로 지우는 방식은 악성코드가 흔히 쓰는 수법이라 쓰지 않는다)
            bool removed = false;
            for (int i = 0; i < 20 && !removed; i++)
            {
                try
                {
                    if (RunningFromInstallDir() && File.Exists(ExePath))
                        File.Move(ExePath, Path.Combine(Path.GetTempPath(), "YBMNaverAlert-old-" + Guid.NewGuid().ToString("N") + ".exe"));
                    if (Directory.Exists(Dir)) Directory.Delete(Dir, true);
                    removed = true;
                }
                catch { Thread.Sleep(250); }
            }
            if (!quiet)
                MessageBox.Show(removed ? "YBM 네이버 예약 알림을 제거했습니다." : "YBM 네이버 예약 알림을 제거했습니다.\n\n일부 파일을 지우지 못했습니다. 필요하면 아래 폴더를 직접 지워 주세요.\n" + Dir,
                    Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // 제거할 때 임시 폴더로 옮겨 둔 예전 exe 정리 (실행 중이 아니면 지워진다)
        static void CleanTempLeftovers()
        {
            try
            {
                foreach (var f in Directory.GetFiles(Path.GetTempPath(), "YBMNaverAlert-old-*.exe"))
                    try { File.Delete(f); } catch { }
            }
            catch { }
        }

        public static bool IsAutoStart()
        {
            try { using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) return k != null && k.GetValue(RunValue) != null; }
            catch { return false; }
        }

        public static void SetAutoStart(bool on)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) k.SetValue(RunValue, "\"" + ExePath + "\" /background");
                else k.DeleteValue(RunValue, false);
            }
        }

        // 실행 중인 프로그램에 신호를 보낸다 (Show = 현황 창 열기, Quit = 종료)
        public static bool Signal(string name)
        {
            try
            {
                EventWaitHandle ev;
                if (EventWaitHandle.TryOpenExisting(@"Local\YBMNaverAlert." + name, out ev))
                {
                    using (ev)
                    {
                        if (Program.IsWindows) { try { AllowSetForegroundWindow(-1); } catch { } }
                        ev.Set();
                    }
                    return true;
                }
            }
            catch { }
            return false;
        }

        static bool IsRunning()
        {
            try
            {
                Mutex m;
                if (!Mutex.TryOpenExisting(MutexName, out m)) return false;
                m.Dispose();
                return true;
            }
            catch (UnauthorizedAccessException) { return true; }
            catch { return false; }
        }

        static void StopRunning()
        {
            if (!IsRunning()) return;
            Signal("Quit");
            for (int i = 0; i < 60 && IsRunning(); i++) Thread.Sleep(100);
            if (!IsRunning()) return;
            // 신호로 안 끝나면, 설치 폴더의 exe 로 실행 중인 것만 골라 끝낸다 (이름만 같은 다른 프로그램은 건드리지 않음)
            int me = Process.GetCurrentProcess().Id;
            foreach (var p in Process.GetProcessesByName("YBMNaverAlert"))
            {
                try
                {
                    if (p.Id != me && string.Equals(Path.GetFullPath(p.MainModule.FileName), Path.GetFullPath(ExePath), StringComparison.OrdinalIgnoreCase))
                    {
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                }
                catch { }
            }
        }

        static void Start(string args)
        {
            Process.Start(new ProcessStartInfo(ExePath, args) { UseShellExecute = false, WorkingDirectory = Dir });
        }

        // 바이트로 복사한다 — File.Copy 는 '인터넷에서 받은 파일' 표시(Zone.Identifier)까지 복사해
        // 윈도우를 켤 때마다 보안 경고가 뜰 수 있다
        static void CopyFresh(string src, string dst)
        {
            var bytes = File.ReadAllBytes(src);
            for (int i = 0; ; i++)
            {
                try { File.WriteAllBytes(dst, bytes); return; }
                catch (IOException) { if (i >= 20) throw; Thread.Sleep(250); }
                catch (UnauthorizedAccessException) { if (i >= 20) throw; Thread.Sleep(250); }
            }
        }

        static bool SameFile(string a, string b)
        {
            try
            {
                var fa = new FileInfo(a);
                var fb = new FileInfo(b);
                if (fa.Length != fb.Length) return false;
                using (var sha = SHA256.Create())
                using (var sa = File.OpenRead(a))
                using (var sb = File.OpenRead(b))
                    return sha.ComputeHash(sa).SequenceEqual(sha.ComputeHash(sb));
            }
            catch { return false; }
        }

        static void RegisterUninstall()
        {
            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", Program.AppName);
                k.SetValue("DisplayVersion", Program.Version);
                k.SetValue("Publisher", "서면 YBM");
                k.SetValue("DisplayIcon", ExePath);
                k.SetValue("InstallLocation", Dir);
                k.SetValue("UninstallString", "\"" + ExePath + "\" /uninstall");
                k.SetValue("QuietUninstallString", "\"" + ExePath + "\" /uninstall /quiet");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)Math.Max(1, new FileInfo(ExePath).Length / 1024), RegistryValueKind.DWord);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd", Kst.Inv));
            }
        }

        // 시작 메뉴 바로가기 — 종료한 뒤 다시 켤 때 쓴다 (실패해도 설치는 계속)
        static void CreateStartMenuLink()
        {
            object shell = null, link = null;
            try
            {
                var t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return;
                shell = Activator.CreateInstance(t);
                link = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { StartMenuLink });
                var lt = link.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { ExePath });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { Dir });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "서면 YBM 네이버 예약(강사 상담) 알림" });
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { ExePath + ",0" });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
            }
            catch (Exception e) { Store.Log("시작 메뉴 바로가기 만들기 실패: " + e.Message); }
            finally
            {
                if (link != null && Marshal.IsComObject(link)) Marshal.FinalReleaseComObject(link);
                if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
            }
        }

        // 예전에 안내했던 PowerShell 판(naver-alert.ps1)이 있으면 자동 실행 등록과 파일만 정리 — 알림이 두 번 뜨지 않게.
        // 다른 프로그램(프로세스)은 건드리지 않는다. 이미 떠 있던 것은 로그오프·재부팅 때 끝난다.
        static void RemoveOldPowerShellVersion()
        {
            try
            {
                var lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "YBM 네이버 예약 알림.lnk");
                if (File.Exists(lnk)) File.Delete(lnk);
            }
            catch { }
            foreach (var f in new[] { "naver-alert.ps1", "snap.json" })
                try { File.Delete(Path.Combine(Dir, f)); } catch { }
        }
    }
}
