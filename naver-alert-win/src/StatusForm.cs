// 예약 현황 창 — 날짜별 강사 상담 시간표 + 최근 변동
// 창을 닫아도 프로그램은 작업 표시줄 아이콘으로 계속 실행된다.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace YbmNaverAlert
{
    sealed class StatusForm : Form
    {
        readonly TrayApp app;
        string day;
        readonly Panel top;
        readonly Label dateLbl, infoLbl, evEmpty;
        readonly Button prevBtn, nextBtn, todayBtn, refreshBtn;
        readonly FlowLayoutPanel cards;
        readonly ListBox events;
        readonly CheckBox autoStart;
        readonly Dictionary<string, Card> cardById = new Dictionary<string, Card>();

        public StatusForm(TrayApp app, string day)
        {
            this.app = app;
            this.day = day ?? Kst.Ymd(Kst.Now);
            Text = Program.AppName;
            Icon = app.FormIcon;
            Font = Ui.Body;
            BackColor = Ui.Bg;
            AutoScaleMode = AutoScaleMode.None;
            StartPosition = FormStartPosition.CenterScreen;
            var wa = Screen.PrimaryScreen.WorkingArea;
            ClientSize = new Size(Math.Min(Ui.S(808), wa.Width - Ui.S(40)), Math.Min(Ui.S(700), wa.Height - Ui.S(60)));
            MinimumSize = new Size(Ui.S(520), Ui.S(460));

            // ── 위: 날짜 이동 · 마지막 확인 · 지금 확인
            top = new Panel { Dock = DockStyle.Top, Height = Ui.S(62), BackColor = Ui.Surface };
            prevBtn = Ui.Btn("<", false, Ui.S(40));
            nextBtn = Ui.Btn(">", false, Ui.S(40));
            todayBtn = Ui.Btn("오늘", false);
            refreshBtn = Ui.Btn("지금 확인", true);
            dateLbl = new Label { AutoSize = false, Font = Ui.Big, ForeColor = Ui.Ink, TextAlign = ContentAlignment.MiddleCenter };
            infoLbl = new Label { AutoSize = false, Font = Ui.Small, ForeColor = Ui.Ink3, TextAlign = ContentAlignment.MiddleRight, AutoEllipsis = true };
            top.Controls.AddRange(new Control[] { prevBtn, dateLbl, nextBtn, todayBtn, infoLbl, refreshBtn });
            top.Resize += (s, e) => LayoutTop();
            top.Paint += (s, e) => { using (var p = new Pen(Ui.Line)) e.Graphics.DrawLine(p, 0, top.Height - 1, top.Width, top.Height - 1); };
            prevBtn.Click += (s, e) => MoveDay(-1);
            nextBtn.Click += (s, e) => MoveDay(1);
            todayBtn.Click += (s, e) => { this.day = Kst.Ymd(Kst.Now); Render(); };
            refreshBtn.Click += (s, e) => app.CheckNow();

            // ── 가운데: 강사별 카드
            cards = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(Ui.S(10)), BackColor = Ui.Bg, WrapContents = true };
            foreach (var it in Booking.Items)
            {
                var c = new Card(it) { Width = Ui.S(242) };
                cards.Controls.Add(c);
                cardById[it.Id] = c;
            }

            // ── 아래: 최근 변동
            var evPanel = new Panel { Dock = DockStyle.Bottom, Height = Ui.S(196), BackColor = Ui.Surface, Padding = new Padding(Ui.S(16), Ui.S(6), Ui.S(16), Ui.S(6)) };
            evPanel.Paint += (s, e) => { using (var p = new Pen(Ui.Line)) e.Graphics.DrawLine(p, 0, 0, evPanel.Width, 0); };
            var evTitle = new Label { Dock = DockStyle.Top, Height = Ui.S(32), Text = "최근 변동  (이 PC에서 감지한 예약·취소)", Font = Ui.BodyBold, ForeColor = Ui.Ink2, TextAlign = ContentAlignment.MiddleLeft };
            events = new ListBox
            {
                Dock = DockStyle.Fill,
                DrawMode = DrawMode.OwnerDrawFixed,
                ItemHeight = Math.Min(250, Ui.S(32)),
                BorderStyle = BorderStyle.None,
                IntegralHeight = false,
                BackColor = Ui.Surface,
                Font = Ui.Body,
            };
            events.DrawItem += DrawEvent;
            events.DoubleClick += (s, e) =>
            {
                var c = events.SelectedItem as Change;
                if (c != null) { this.day = c.T.Substring(0, 10); Render(); }
            };
            evEmpty = new Label
            {
                Dock = DockStyle.Fill,
                Text = "아직 감지된 변동이 없습니다.\n프로그램을 설치한 뒤부터 생긴 예약·취소가 여기에 쌓입니다.",
                ForeColor = Ui.Ink3,
                Font = Ui.Body,
                TextAlign = ContentAlignment.MiddleCenter,
            };
            evPanel.Controls.Add(events);
            evPanel.Controls.Add(evEmpty);
            evPanel.Controls.Add(evTitle);

            // ── 맨 아래: 자동 실행 · 안내 · 제거
            var bottom = new Panel { Dock = DockStyle.Bottom, Height = Ui.S(40), BackColor = Ui.Surface2 };
            bottom.Paint += (s, e) => { using (var p = new Pen(Ui.Line)) e.Graphics.DrawLine(p, 0, 0, bottom.Width, 0); };
            autoStart = new CheckBox { Text = "윈도우를 켤 때 자동 실행", AutoSize = true, Font = Ui.Small, ForeColor = Ui.Ink2, BackColor = Color.Transparent };
            var note = new Label { Text = "창을 닫아도 오른쪽 아래 아이콘으로 계속 확인합니다 · v" + Program.Version, AutoSize = true, Font = Ui.Small, ForeColor = Ui.Ink3, BackColor = Color.Transparent };
            var uninstall = new LinkLabel { Text = "프로그램 제거", AutoSize = true, Font = Ui.Small, LinkColor = Ui.Ink3, ActiveLinkColor = Ui.Red, BackColor = Color.Transparent };
            bool installed = Installer.RunningFromInstallDir();
            autoStart.Visible = uninstall.Visible = installed;
            if (installed) autoStart.Checked = Installer.IsAutoStart();
            autoStart.CheckedChanged += (s, e) =>
            {
                try { Installer.SetAutoStart(autoStart.Checked); }
                catch (Exception ex) { MessageBox.Show(this, "설정을 바꾸지 못했습니다.\n\n" + ex.Message, Program.AppName); }
            };
            uninstall.LinkClicked += (s, e) => app.UninstallFromUi();
            bottom.Controls.AddRange(new Control[] { autoStart, note, uninstall });
            bottom.Resize += (s, e) =>
            {
                int x = Ui.S(14);
                int cy = bottom.Height / 2;
                if (autoStart.Visible) { autoStart.Location = new Point(x, cy - autoStart.Height / 2); x = autoStart.Right + Ui.S(18); }
                note.Location = new Point(x, cy - note.Height / 2);
                uninstall.Location = new Point(bottom.Width - Ui.S(14) - uninstall.Width, cy - uninstall.Height / 2);
            };

            // 도킹은 나중에 넣은 것부터 자리를 잡는다 → 가운데(Fill)를 먼저 넣는다
            Controls.Add(cards);
            Controls.Add(evPanel);
            Controls.Add(bottom);
            Controls.Add(top);

            KeyPreview = true;
            KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Left) { MoveDay(-1); e.Handled = true; }
                else if (e.KeyCode == Keys.Right) { MoveDay(1); e.Handled = true; }
                else if (e.KeyCode == Keys.F5) { app.CheckNow(); e.Handled = true; }
                else if (e.KeyCode == Keys.Escape) { Close(); e.Handled = true; }
            };

            LayoutTop();
            Render();
        }

        void LayoutTop()
        {
            int h = top.Height;
            int x = Ui.S(16);
            int by = (h - prevBtn.Height) / 2;
            prevBtn.Location = new Point(x, by);
            x = prevBtn.Right + Ui.S(4);
            dateLbl.Bounds = new Rectangle(x, 0, Ui.S(150), h);
            x = dateLbl.Right + Ui.S(4);
            nextBtn.Location = new Point(x, by);
            x = nextBtn.Right + Ui.S(8);
            todayBtn.Location = new Point(x, by);
            x = todayBtn.Right + Ui.S(12);
            refreshBtn.Location = new Point(top.Width - Ui.S(16) - refreshBtn.Width, by);
            infoLbl.Bounds = new Rectangle(x, 0, Math.Max(0, refreshBtn.Left - Ui.S(12) - x), h);
        }

        void MoveDay(int delta)
        {
            var d = DateTime.ParseExact(day, "yyyy-MM-dd", Kst.Inv).AddDays(delta);
            var today = Kst.Now.Date;
            if (d < today || d > today.AddDays(Booking.DaysAhead)) return;
            day = Kst.Ymd(d);
            Render();
        }

        public void SetDay(string d) { if (d != null) { day = d; Render(); } }

        public void Render()
        {
            if (IsDisposed) return;
            string today = Kst.Ymd(Kst.Now);
            if (string.CompareOrdinal(day, today) < 0) day = today;
            string last = Kst.Ymd(Kst.Now.AddDays(Booking.DaysAhead));
            dateLbl.Text = Kst.Day(day) + (day == today ? " 오늘" : "");
            dateLbl.ForeColor = day == today ? Ui.Ink : Ui.Ink2;
            prevBtn.Enabled = string.CompareOrdinal(day, today) > 0;
            nextBtn.Enabled = string.CompareOrdinal(day, last) < 0;
            todayBtn.Enabled = day != today;

            var failed = Booking.Items.Where(it => { ItemResult r; return app.Latest.TryGetValue(it.Id, out r) && !r.Ok; }).Select(it => it.Name).ToList();
            if (app.Checking) { infoLbl.Text = "확인 중…"; infoLbl.ForeColor = Ui.Ink3; }
            else if (!app.CheckedAt.HasValue) { infoLbl.Text = "아직 확인 전"; infoLbl.ForeColor = Ui.Ink3; }
            else if (failed.Count == Booking.Items.Length) { infoLbl.Text = "확인 실패 " + app.CheckedAt.Value.ToString("HH:mm", Kst.Inv) + " — 인터넷 연결을 확인하세요"; infoLbl.ForeColor = Ui.Red; }
            else
            {
                infoLbl.Text = "마지막 확인 " + app.CheckedAt.Value.ToString("HH:mm", Kst.Inv) + " · 2분마다 자동" + (failed.Count > 0 ? " · " + string.Join(", ", failed) + " 확인 실패" : "");
                infoLbl.ForeColor = failed.Count > 0 ? Ui.Red : Ui.Ink3;
            }
            refreshBtn.Enabled = !app.Checking;

            string now = Kst.Stamp(Kst.Now);
            cards.SuspendLayout();
            foreach (var it in Booking.Items)
            {
                List<Slot> slots;
                app.LastGood.TryGetValue(it.Id, out slots);
                ItemResult latest;
                app.Latest.TryGetValue(it.Id, out latest);
                var daySlots = slots == null ? null : slots.Where(s => s.T.StartsWith(day, StringComparison.Ordinal) && (s.Open || s.B > 0)).ToList();
                cardById[it.Id].SetData(day, now, daySlots, latest != null && !latest.Ok ? latest.Error : null);
            }
            cards.ResumeLayout(true);

            events.BeginUpdate();
            events.Items.Clear();
            foreach (var c in app.History.Take(100)) events.Items.Add(c);
            events.EndUpdate();
            events.Visible = events.Items.Count > 0;
            evEmpty.Visible = !events.Visible;
        }

        void DrawEvent(object sender, DrawItemEventArgs e)
        {
            if (e.Index < 0 || e.Index >= events.Items.Count) return;
            var c = (Change)events.Items[e.Index];
            var g = e.Graphics;
            var r = e.Bounds;
            using (var bg = new SolidBrush(Ui.Surface)) g.FillRectangle(bg, r);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var badge = new Rectangle(r.X + Ui.S(2), r.Y + (r.Height - Ui.S(22)) / 2, Ui.S(46), Ui.S(22));
            Ui.FillRound(g, badge, Ui.S(11), c.Booked ? Ui.GreenBg : Ui.RedBg);
            Ui.Text(g, c.Booked ? "예약" : "취소", Ui.SmallBold, c.Booked ? Ui.Green : Ui.Red, badge, Ui.CenterMid);
            int rightW = Ui.S(120);
            string main = c.Name + "   " + Kst.When(c.T) + (c.Diff > 1 ? " · " + c.Diff + "건" : "");
            Ui.Text(g, main, Ui.Body, Ui.Ink, new Rectangle(badge.Right + Ui.S(10), r.Y, r.Width - badge.Width - Ui.S(14) - rightW, r.Height), Ui.LeftMid);
            Ui.Text(g, c.DetectedAt.ToString("M/d HH:mm", Kst.Inv) + " 감지", Ui.Small, Ui.Ink3, new Rectangle(r.Right - rightW, r.Y, rightW - Ui.S(2), r.Height), Ui.RightMid);
            using (var p = new Pen(Ui.Line)) g.DrawLine(p, r.X, r.Bottom - 1, r.Right, r.Bottom - 1);
        }
    }

    // 강사 한 명의 그날 시간표 카드 — 누르면 네이버 예약 페이지(그 날짜)가 열린다
    sealed class Card : Control
    {
        readonly Item item;
        string day, now, error;
        List<Slot> slots;
        readonly ToolTip tip = new ToolTip();

        int HeaderH { get { return Ui.S(44); } }
        int RowH { get { return Ui.S(31); } }

        public Card(Item item)
        {
            this.item = item;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Ui.Bg;
            Margin = new Padding(Ui.S(6));
            Cursor = Cursors.Hand;
            tip.SetToolTip(this, "누르면 네이버 예약 페이지가 열립니다");
            Height = HeaderH + RowH + Ui.S(14);
        }

        public void SetData(string day, string now, List<Slot> slots, string error)
        {
            this.day = day;
            this.now = now;
            this.slots = slots;
            this.error = error;
            int rows = slots == null || slots.Count == 0 ? 1 : slots.Count;
            int h = HeaderH + Ui.S(6) + rows * RowH + Ui.S(8);
            if (error != null && slots != null) h += Ui.S(24);
            if (Height != h) Height = h;
            Invalidate();
        }

        protected override void OnClick(EventArgs e)
        {
            base.OnClick(e);
            Ui.Open(Booking.PageUrl(item.Id, day));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var box = new Rectangle(0, 0, Width - 1, Height - 1);
            Ui.FillRound(g, box, Ui.S(12), Ui.Surface);
            Ui.DrawRound(g, box, Ui.S(12), Ui.Line);

            int pad = Ui.S(14);
            int booked = slots == null ? 0 : slots.Sum(s => s.B);
            Ui.Text(g, item.Name + "  ↗", Ui.Title, Ui.Ink, new Rectangle(pad, 0, Width - pad * 2 - Ui.S(56), HeaderH), Ui.LeftMid);
            if (slots != null)
                Ui.Text(g, booked + "건", Ui.BodyBold, booked > 0 ? Ui.Green : Ui.Ink3, new Rectangle(Width - pad - Ui.S(60), 0, Ui.S(60), HeaderH), Ui.RightMid);
            using (var p = new Pen(Ui.Line)) g.DrawLine(p, 1, HeaderH, Width - 2, HeaderH);

            int y = HeaderH + Ui.S(6);
            if (slots == null)
            {
                Ui.Text(g, error != null ? "조회 실패 · " + error : "확인 중…", Ui.Small, error != null ? Ui.Red : Ui.Ink3, new Rectangle(pad, y, Width - pad * 2, RowH), Ui.LeftMid);
                return;
            }
            if (slots.Count == 0)
            {
                Ui.Text(g, "이날 예약 가능한 시간 없음", Ui.Small, Ui.Ink3, new Rectangle(pad, y, Width - pad * 2, RowH), Ui.LeftMid);
                y += RowH;
            }
            foreach (var s in slots)
            {
                var r = new Rectangle(Ui.S(8), y + Ui.S(2), Width - Ui.S(16), RowH - Ui.S(4));
                bool past = string.CompareOrdinal(s.T, now) < 0;
                bool has = s.B > 0;
                if (has) Ui.FillRound(g, r, Ui.S(7), past ? Ui.Surface2 : Ui.GreenBg);
                Color ink = past ? Ui.Ink3 : (has ? Ui.Green : Ui.Ink2);
                Ui.Text(g, s.T.Substring(11, 5), has ? Ui.BodyBold : Ui.Body, ink, new Rectangle(r.X + Ui.S(8), r.Y, Ui.S(70), r.Height), Ui.LeftMid);
                string st = has ? "예약 " + s.B + (s.S > 1 ? "/" + s.S : "") : "비어있음";
                Ui.Text(g, st, has ? Ui.BodyBold : Ui.Small, has ? ink : Ui.Ink3, new Rectangle(r.Right - Ui.S(110), r.Y, Ui.S(102), r.Height), Ui.RightMid);
                y += RowH;
            }
            if (error != null)
                Ui.Text(g, "최근 조회 실패 · 이전 정보 표시", Ui.Small, Ui.Red, new Rectangle(pad, y + Ui.S(2), Width - pad * 2, Ui.S(20)), Ui.LeftMid);
        }
    }
}
