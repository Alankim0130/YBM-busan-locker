// 화면 오른쪽 아래 알림창
//   - '확인'을 누를 때까지 남는다 (자리를 비워도 놓치지 않게)
//   - 다른 창의 입력 포커스를 뺏지 않는다
//   - 새 변동이 오면 같은 창 맨 위에 쌓인다
//   - 윈도우 알림 설정·방해 금지와 상관없이 뜬다
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Media;
using System.Windows.Forms;

namespace YbmNaverAlert
{
    sealed class AlertForm : Form
    {
        sealed class Line
        {
            public int Kind;          // 1 = 예약, -1 = 취소, 0 = 안내
            public string Main, Sub, Day;
        }

        sealed class Row
        {
            public Line L;
            public Rectangle R;
        }

        const int MaxLines = 6;
        readonly List<Line> lines = new List<Line>();
        readonly List<Row> rows = new List<Row>();
        readonly Button okBtn, openBtn;
        Rectangle closeRect, moreRect;
        int hidden;

        int W { get { return Ui.S(390); } }
        int HeaderH { get { return Ui.S(42); } }
        int RowH { get { return Ui.S(34); } }
        int FooterH { get { return Ui.S(56); } }

        public AlertForm(Action<string> onOpen)
        {
            Text = Program.AppName;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Ui.Surface;
            Font = Ui.Body;
            DoubleBuffered = true;

            okBtn = Ui.Btn("확인", true, Ui.S(76));
            okBtn.Click += (s, e) => Close();
            openBtn = Ui.Btn("예약 현황 보기", false);
            openBtn.Click += (s, e) => { var d = FirstDay(); Close(); onOpen(d); };
            Controls.Add(okBtn);
            Controls.Add(openBtn);

            MouseClick += (s, e) => { if (closeRect.Contains(e.Location)) Close(); };
            MouseMove += (s, e) => { Cursor = closeRect.Contains(e.Location) ? Cursors.Hand : Cursors.Default; };
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008;  // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST
                cp.ClassStyle |= 0x00020000;                          // CS_DROPSHADOW
                return cp;
            }
        }

        string FirstDay()
        {
            foreach (var l in lines) if (l.Day != null) return l.Day;
            return null;
        }

        public void AddChanges(IList<Change> cs)
        {
            var add = new List<Line>();
            foreach (var c in cs)
                add.Add(new Line
                {
                    Kind = c.Booked ? 1 : -1,
                    Main = c.Name + "   " + Kst.When(c.T) + (c.Diff > 1 ? " · " + c.Diff + "건" : ""),
                    Sub = c.DetectedAt.ToString("HH:mm", Kst.Inv),
                    Day = c.T.Substring(0, 10),
                });
            lines.InsertRange(0, add);
            Relayout();
        }

        public void AddInfo(string title, string message)
        {
            lines.Insert(0, new Line { Kind = 0, Main = title, Sub = message });
            Relayout();
        }

        int InfoHeight(Line l)
        {
            int textW = W - Ui.S(28);
            int h = TextRenderer.MeasureText(l.Sub ?? "", Ui.Body, new Size(textW, int.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix).Height;
            return Ui.S(24) + h + Ui.S(4);
        }

        void Relayout()
        {
            rows.Clear();
            int y = HeaderH + Ui.S(10);
            int shown = 0;
            foreach (var l in lines)
            {
                if (shown == MaxLines) break;
                int h = l.Kind == 0 ? InfoHeight(l) : RowH;
                rows.Add(new Row { L = l, R = new Rectangle(Ui.S(14), y, W - Ui.S(28), h) });
                y += h + Ui.S(4);
                shown++;
            }
            hidden = lines.Count - shown;
            if (hidden > 0)
            {
                moreRect = new Rectangle(Ui.S(14), y, W - Ui.S(28), Ui.S(22));
                y += Ui.S(26);
            }
            int H = y + Ui.S(6) + FooterH;
            ClientSize = new Size(W, H);

            okBtn.Location = new Point(W - Ui.S(14) - okBtn.Width, H - FooterH + (FooterH - okBtn.Height) / 2);
            openBtn.Location = new Point(okBtn.Left - Ui.S(8) - openBtn.Width, okBtn.Top);
            closeRect = new Rectangle(W - Ui.S(40), (HeaderH - Ui.S(30)) / 2, Ui.S(30), Ui.S(30));

            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Right - W - Ui.S(14), wa.Bottom - H - Ui.S(14));
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            using (var b = new SolidBrush(Ui.Brand)) g.FillRectangle(b, 0, 0, Width, HeaderH);
            int n = 0;
            foreach (var l in lines) if (l.Kind != 0) n++;
            string title = n > 0 ? "네이버 예약 변동 " + n + "건" : "네이버 예약 알림";
            Ui.Text(g, title, Ui.Title, Color.White, new Rectangle(Ui.S(16), 0, Width - Ui.S(70), HeaderH), Ui.LeftMid);
            Ui.Text(g, "×", Ui.Big, Color.FromArgb(210, 255, 255, 255), closeRect, Ui.CenterMid);

            foreach (var row in rows)
            {
                var l = row.L;
                var r = row.R;
                if (l.Kind == 0)
                {
                    Ui.Text(g, l.Main, Ui.BodyBold, Ui.Ink, new Rectangle(r.X, r.Y, r.Width, Ui.S(22)), Ui.LeftMid);
                    TextRenderer.DrawText(g, l.Sub ?? "", Ui.Body, new Rectangle(r.X, r.Y + Ui.S(24), r.Width, r.Height - Ui.S(24)), Ui.Ink2,
                        TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.Left | TextFormatFlags.Top);
                    continue;
                }
                bool booked = l.Kind > 0;
                var badge = new Rectangle(r.X, r.Y + (r.Height - Ui.S(24)) / 2, Ui.S(48), Ui.S(24));
                Ui.FillRound(g, badge, Ui.S(12), booked ? Ui.GreenBg : Ui.RedBg);
                Ui.Text(g, booked ? "예약" : "취소", Ui.SmallBold, booked ? Ui.Green : Ui.Red, badge, Ui.CenterMid);
                int subW = Ui.S(48);
                Ui.Text(g, l.Main, Ui.BodyBold, Ui.Ink, new Rectangle(badge.Right + Ui.S(10), r.Y, r.Width - badge.Width - Ui.S(10) - subW, r.Height), Ui.LeftMid);
                Ui.Text(g, l.Sub, Ui.Small, Ui.Ink3, new Rectangle(r.Right - subW, r.Y, subW, r.Height), Ui.RightMid);
            }

            if (hidden > 0)
                Ui.Text(g, "외 " + hidden + "건 더 있어요 — ‘예약 현황 보기’에서 확인", Ui.Small, Ui.Ink3, moreRect, Ui.LeftMid);

            using (var p = new Pen(Ui.Line)) g.DrawLine(p, 0, Height - FooterH, Width, Height - FooterH);
            using (var p = new Pen(Ui.LineStrong)) g.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
        }

        static SoundPlayer player;

        public static void PlaySound()
        {
            try
            {
                if (player == null)
                {
                    var media = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Media");
                    foreach (var f in new[] { "Windows Notify Calendar.wav", "Windows Notify System Generic.wav", "Windows Notify.wav", "notify.wav" })
                    {
                        var p = Path.Combine(media, f);
                        if (File.Exists(p)) { player = new SoundPlayer(p); break; }
                    }
                }
                if (player != null) player.Play();
                else SystemSounds.Asterisk.Play();
            }
            catch { }
        }
    }
}
