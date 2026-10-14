// 공통 색·글꼴·크기(고해상도 배율)·그리기 도우미
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace YbmNaverAlert
{
    static class Ui
    {
        // 화면 배율(100% = 1, 150% = 1.5). 모든 크기는 96DPI 기준 픽셀 × Scale
        public static float Scale = 1f;
        public static int S(float px) { return (int)Math.Round(px * Scale); }

        // 사물함 웹과 같은 색
        public static readonly Color Bg = Hex("#eaeef3"), Surface = Color.White, Surface2 = Hex("#f6f8fb"),
            Line = Hex("#e2e7ee"), LineStrong = Hex("#cfd7e1"), Ink = Hex("#19212e"), Ink2 = Hex("#586273"), Ink3 = Hex("#8b94a3"),
            Brand = Hex("#1d2531"), BrandDark = Hex("#0f1520"), GreenBg = Hex("#e3f3ec"), Green = Hex("#1d7a54"),
            RedBg = Hex("#fbe3de"), Red = Hex("#b23a22");

        static Color Hex(string h) { return ColorTranslator.FromHtml(h); }

        public static Font Small, SmallBold, Body, BodyBold, Title, Big;

        public static void Init(float? forced)
        {
            if (forced.HasValue) Scale = forced.Value;
            else
            {
                try { using (var g = Graphics.FromHwnd(IntPtr.Zero)) Scale = Math.Max(1f, g.DpiX / 96f); }
                catch { Scale = 1f; }
            }
            Small = F(12f, FontStyle.Regular);
            SmallBold = F(12f, FontStyle.Bold);
            Body = F(13.5f, FontStyle.Regular);
            BodyBold = F(13.5f, FontStyle.Bold);
            Title = F(15f, FontStyle.Bold);
            Big = F(19f, FontStyle.Bold);
        }

        static Font F(float px, FontStyle st) { return new Font("Malgun Gothic", px * Scale, st, GraphicsUnit.Pixel); }

        public const TextFormatFlags LeftMid = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine;
        public const TextFormatFlags RightMid = TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
        public const TextFormatFlags CenterMid = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;

        public static void Text(Graphics g, string s, Font f, Color c, Rectangle r, TextFormatFlags fl)
        {
            TextRenderer.DrawText(g, s, f, r, c, fl);
        }

        public static GraphicsPath Round(Rectangle r, int radius)
        {
            var p = new GraphicsPath();
            int d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 1) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void FillRound(Graphics g, Rectangle r, int radius, Color c)
        {
            using (var b = new SolidBrush(c)) using (var p = Round(r, radius)) g.FillPath(b, p);
        }

        public static void DrawRound(Graphics g, Rectangle r, int radius, Color c)
        {
            using (var pen = new Pen(c)) using (var p = Round(r, radius)) g.DrawPath(pen, p);
        }

        // 납작한 버튼 — 크기는 글자에 맞춰 직접 정한다(배율 계산이 확실하도록)
        public static Button Btn(string text, bool primary, int minWidth = 0)
        {
            var f = primary ? BodyBold : Body;
            var b = new Button
            {
                Text = text,
                Font = f,
                FlatStyle = FlatStyle.Flat,
                UseVisualStyleBackColor = false,
                BackColor = primary ? Brand : Surface,
                ForeColor = primary ? Color.White : Ink,
                Cursor = Cursors.Hand,
                TabStop = true,
            };
            b.FlatAppearance.BorderSize = 1;
            b.FlatAppearance.BorderColor = primary ? Brand : LineStrong;
            b.FlatAppearance.MouseOverBackColor = primary ? BrandDark : Surface2;
            b.FlatAppearance.MouseDownBackColor = primary ? BrandDark : Line;
            int w = TextRenderer.MeasureText(text, f).Width + S(30);
            b.Size = new Size(Math.Max(Math.Max(w, minWidth), S(40)), S(34));
            return b;
        }

        // 내장 PNG(16~64px)에서 원하는 크기에 가까운 아이콘을 만든다
        public static Icon MakeIcon(int want)
        {
            int[] sizes = { 16, 20, 24, 32, 40, 48, 64 };
            int pick = sizes[sizes.Length - 1];
            foreach (var z in sizes) if (z >= want) { pick = z; break; }
            try
            {
                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("icon" + pick + ".png"))
                {
                    if (s == null) return SystemIcons.Application;
                    using (var src = new Bitmap(s))
                    using (var bmp = new Bitmap(want, want))
                    {
                        using (var g = Graphics.FromImage(bmp))
                        {
                            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            g.DrawImage(src, 0, 0, want, want);
                        }
                        return Icon.FromHandle(bmp.GetHicon());
                    }
                }
            }
            catch { return SystemIcons.Application; }
        }

        public static void Open(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception e) { Store.Log("열기 실패: " + url + " — " + e.Message); }
        }
    }
}
