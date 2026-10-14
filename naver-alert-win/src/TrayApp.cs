// 작업 표시줄(오른쪽 아래) 아이콘으로 상주하며 2분마다 확인한다.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace YbmNaverAlert
{
    sealed class TrayApp : ApplicationContext
    {
        readonly NotifyIcon tray;
        readonly System.Windows.Forms.Timer timer;
        readonly Control ui;
        readonly bool installed;
        ToolStripMenuItem autoItem;
        StatusForm status;
        AlertForm alert;
        System.Windows.Forms.Timer resumeTimer;
        EventWaitHandle showEv, quitEv;
        int fails;
        bool failAlerted;

        public readonly Icon FormIcon;
        public readonly Dictionary<string, ItemResult> Latest = new Dictionary<string, ItemResult>();
        public readonly Dictionary<string, List<Slot>> LastGood = new Dictionary<string, List<Slot>>();
        public readonly List<Change> History;
        public DateTime? CheckedAt;
        public bool Checking;

        public TrayApp(Options o)
        {
            installed = Installer.RunningFromInstallDir();
            History = Store.LoadEvents();
            FormIcon = Ui.MakeIcon(Ui.S(32));

            ui = new Control();
            ui.CreateControl();
            var unused = ui.Handle;  // 다른 스레드에서 UI 로 넘길 때 쓰는 창 핸들

            tray = new NotifyIcon
            {
                Icon = Ui.MakeIcon(SystemInformation.SmallIconSize.Width),
                Text = Program.AppName,
                ContextMenuStrip = BuildMenu(),
            };
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowStatus(null); };
            try { tray.Visible = true; } catch (Exception e) { Store.Log("작업 표시줄 아이콘 표시 실패: " + e.Message); }

            timer = new System.Windows.Forms.Timer { Interval = (o.Interval ?? 120) * 1000 };
            timer.Tick += (s, e) => CheckNow();
            timer.Start();

            StartSignals();
            try { SystemEvents.PowerModeChanged += OnPower; } catch { }

            if (o.Installed)
            {
                ShowStatus(null);
                Info("설치가 끝났습니다", "작업 표시줄 오른쪽 아래 아이콘을 누르면 언제든 예약 현황을 볼 수 있어요. 예약이 추가되거나 취소되면 이 자리에 알려 드립니다.", false);
            }
            else if (!o.Background) ShowStatus(null);

            Store.Log("시작 v" + Program.Version + (o.Background ? " (자동 실행)" : ""));
            ui.BeginInvoke(new Action(CheckNow));
        }

        ContextMenuStrip BuildMenu()
        {
            var m = new ContextMenuStrip { Font = Ui.Body };
            m.Items.Add(new ToolStripMenuItem("예약 현황 보기", null, (s, e) => ShowStatus(null)) { Font = Ui.BodyBold });
            m.Items.Add(new ToolStripMenuItem("지금 확인", null, (s, e) => CheckNow()));
            m.Items.Add(new ToolStripMenuItem("알림 미리보기", null, (s, e) => Info("알림 미리보기", "예약이 추가되거나 취소되면 이 자리에 이렇게 알려 드립니다.", true)));
            m.Items.Add(new ToolStripSeparator());
            if (installed)
            {
                autoItem = new ToolStripMenuItem("윈도우를 켤 때 자동 실행", null, (s, e) =>
                {
                    try { Installer.SetAutoStart(!Installer.IsAutoStart()); }
                    catch (Exception ex) { MessageBox.Show("설정을 바꾸지 못했습니다.\n\n" + ex.Message, Program.AppName); }
                });
                m.Items.Add(autoItem);
                m.Items.Add(new ToolStripMenuItem("프로그램 제거…", null, (s, e) => UninstallFromUi()));
                m.Items.Add(new ToolStripSeparator());
            }
            m.Items.Add(new ToolStripMenuItem("종료", null, (s, e) => ConfirmExit()));
            m.Opening += (s, e) => { if (autoItem != null) autoItem.Checked = Installer.IsAutoStart(); };
            return m;
        }

        void OnUi(Action a)
        {
            try { if (!ui.IsDisposed) ui.BeginInvoke(a); } catch { }
        }

        // 두 번째로 실행된 프로그램·설치 프로그램이 보내는 신호 (현황 창 열기 / 종료)
        void StartSignals()
        {
            try
            {
                showEv = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\YBMNaverAlert.Show");
                quitEv = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\YBMNaverAlert.Quit");
                var th = new Thread(() =>
                {
                    var hs = new WaitHandle[] { showEv, quitEv };
                    while (true)
                    {
                        int i = WaitHandle.WaitAny(hs);
                        if (i == 0) OnUi(() => ShowStatus(null));
                        else { OnUi(ExitThread); return; }
                    }
                }) { IsBackground = true, Name = "signals" };
                th.Start();
            }
            catch (Exception e) { Store.Log("신호 대기 준비 실패: " + e.Message); }
        }

        void OnPower(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode != PowerModes.Resume) return;
            // 절전에서 깨어나면 인터넷이 붙을 때까지 잠시 기다렸다가 확인
            OnUi(() =>
            {
                if (resumeTimer == null)
                {
                    resumeTimer = new System.Windows.Forms.Timer { Interval = 20000 };
                    resumeTimer.Tick += (s, a) => { resumeTimer.Stop(); CheckNow(); };
                }
                resumeTimer.Stop();
                resumeTimer.Start();
            });
        }

        public async void CheckNow()
        {
            try { await CheckAsync(); }
            catch (Exception e) { Store.Log("확인 오류: " + e); }
        }

        async Task CheckAsync()
        {
            if (Checking) return;
            Checking = true;
            RefreshViews();
            try
            {
                var now = Kst.Now;
                string from = Kst.Ymd(now), to = Kst.Ymd(now.AddDays(Booking.DaysAhead));
                var results = await Task.WhenAll(Booking.Items.Select(it => Booking.FetchAsync(it, from, to)));

                var prev = Store.LoadSnap();
                var next = new Dictionary<string, int>();
                var changes = Booking.Diff(prev, results, Kst.Stamp(Kst.Now), next, Kst.Now);   // 시각은 모두 한국 시각으로
                Store.SaveSnap(next);
                if (prev == null) Store.Log("기준선 저장: " + next.Count + "칸");

                foreach (var r in results)
                {
                    Latest[r.Item.Id] = r;
                    if (r.Ok) LastGood[r.Item.Id] = r.Slots;
                    else Store.Log("조회 실패: " + r.Item.Name + " — " + r.Error);
                }
                CheckedAt = Kst.Now;

                if (results.All(r => !r.Ok))
                {
                    fails++;
                    if (fails >= 15 && !failAlerted)   // 2분 × 15 = 30분
                    {
                        failAlerted = true;
                        Info("예약 현황을 확인하지 못하고 있어요", "30분째 네이버 예약을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요. (" + results[0].Error + ")", true);
                    }
                }
                else
                {
                    if (failAlerted) Info("다시 확인하고 있어요", "네이버 예약 확인이 정상으로 돌아왔습니다.", false);
                    fails = 0;
                    failAlerted = false;
                }

                if (changes.Count > 0)
                {
                    History.InsertRange(0, changes);
                    if (History.Count > 200) History.RemoveRange(200, History.Count - 200);
                    Store.SaveEvents(History);
                    foreach (var c in changes) Store.Log((c.Booked ? "예약 " : "취소 ") + c.Name + " " + c.T + " → " + c.B + "/" + c.S);
                    Alert().AddChanges(changes);
                    ShowAlert(true);
                }
            }
            finally
            {
                Checking = false;
                UpdateTrayText();
                RefreshViews();
            }
        }

        void RefreshViews()
        {
            if (status != null && !status.IsDisposed) status.Render();
        }

        void UpdateTrayText()
        {
            string today = Kst.Ymd(Kst.Now);
            int n = 0;
            foreach (var kv in LastGood) foreach (var s in kv.Value) if (s.T.StartsWith(today, StringComparison.Ordinal)) n += s.B;
            string line2 = !CheckedAt.HasValue ? "확인 전"
                : Latest.Count > 0 && Latest.Values.All(r => !r.Ok) ? "확인 실패 — 인터넷 연결 확인"
                : "오늘 예약 " + n + "건 · " + CheckedAt.Value.ToString("HH:mm", Kst.Inv) + " 확인";
            var text = Program.AppName + "\n" + line2;
            try { tray.Text = text.Length > 63 ? text.Substring(0, 63) : text; } catch { }
        }

        AlertForm Alert()
        {
            if (alert == null || alert.IsDisposed)
            {
                alert = new AlertForm(day => ShowStatus(day));
                alert.FormClosed += (s, e) => alert = null;
            }
            return alert;
        }

        [DllImport("shell32.dll")]
        static extern int SHQueryUserNotificationState(out int state);

        // 발표(슬라이드 쇼)·전체 화면 중인지 — 그동안은 알림창을 미룬다
        static bool UserBusy()
        {
            if (!Program.IsWindows) return false;
            try
            {
                int st;
                if (SHQueryUserNotificationState(out st) == 0) return st == 2 || st == 3 || st == 4;  // BUSY · D3D 전체 화면 · 프레젠테이션 모드
            }
            catch { }
            return false;
        }

        bool pending, pendingSound;
        DateTime pendingSince;
        System.Windows.Forms.Timer busyTimer;

        void ShowAlert(bool sound)
        {
            if (UserBusy())
            {
                if (!pending) { pending = true; pendingSince = DateTime.UtcNow; }
                pendingSound |= sound;
                if (busyTimer == null)
                {
                    busyTimer = new System.Windows.Forms.Timer { Interval = 15000 };
                    busyTimer.Tick += (s, e) =>
                    {
                        // 전체 화면이 끝나거나 30분이 지나면 보여 준다
                        if (!pending) { busyTimer.Stop(); return; }
                        if (UserBusy() && (DateTime.UtcNow - pendingSince).TotalMinutes < 30) return;
                        busyTimer.Stop();
                        pending = false;
                        Reveal(pendingSound);
                        pendingSound = false;
                    };
                }
                busyTimer.Start();
                return;
            }
            Reveal(sound);
        }

        void Reveal(bool sound)
        {
            if (alert == null || alert.IsDisposed) return;
            if (!alert.Visible) alert.Show();
            else alert.Invalidate();
            if (sound) AlertForm.PlaySound();
        }

        void Info(string title, string message, bool sound)
        {
            Alert().AddInfo(title, message);
            ShowAlert(sound);
        }

        public void ShowStatus(string day)
        {
            if (status == null || status.IsDisposed)
            {
                status = new StatusForm(this, day);
                status.FormClosed += (s, e) => status = null;
                status.Show();
            }
            else
            {
                status.SetDay(day);
                if (status.WindowState == FormWindowState.Minimized) status.WindowState = FormWindowState.Normal;
                status.Show();
            }
            status.Activate();
            status.BringToFront();
        }

        public void UninstallFromUi()
        {
            try { Process.Start(new ProcessStartInfo(Installer.ExePath, "/uninstall") { UseShellExecute = false }); }
            catch (Exception e) { MessageBox.Show("제거 프로그램을 시작하지 못했습니다.\n\n" + e.Message, Program.AppName); }
        }

        void ConfirmExit()
        {
            var msg = "종료하면 다시 실행할 때까지 예약 알림이 오지 않습니다." + (installed && Installer.IsAutoStart() ? "\n(윈도우를 다시 켜면 자동으로 실행됩니다)" : "") + "\n\n종료할까요?";
            if (MessageBox.Show(msg, Program.AppName, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK) ExitThread();
        }

        protected override void ExitThreadCore()
        {
            try { SystemEvents.PowerModeChanged -= OnPower; } catch { }
            timer.Stop();
            if (resumeTimer != null) resumeTimer.Stop();
            if (busyTimer != null) busyTimer.Stop();
            try { tray.Visible = false; tray.Dispose(); } catch { }
            if (alert != null && !alert.IsDisposed) alert.Close();
            if (status != null && !status.IsDisposed) status.Close();
            Store.Log("종료");
            base.ExitThreadCore();
        }
    }
}
