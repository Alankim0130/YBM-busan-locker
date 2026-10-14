// res/icon*.svg → res/icon{16..256}.png + res/app.ico (PNG 압축 ICO)
// 실행: PW=$(npm root -g)/playwright node tools/make-icons.js
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs"), path = require("path");
const res = path.join(__dirname, "..", "res");
const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined });
  const page = await b.newPage();
  const pngs = [];
  for (const s of sizes) {
    const svg = fs.readFileSync(path.join(res, s <= 24 ? "icon-small.svg" : "icon.svg"), "utf8").replace("<svg ", `<svg width="${s}" height="${s}" `);
    await page.setViewportSize({ width: s, height: s });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
    fs.writeFileSync(path.join(res, `icon${s}.png`), buf);
    pngs.push([s, buf]);
  }
  await b.close();
  // ICO: 헤더 6 + 항목 16×n + PNG 데이터
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([s, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  fs.writeFileSync(path.join(res, "app.ico"), Buffer.concat([head, ...pngs.map(p => p[1])]));
  console.log("ok", sizes.join(","));
})();
