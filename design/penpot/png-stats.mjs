import fs from "node:fs";
import zlib from "node:zlib";

function decode(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, stride, pixels: out };
}

const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

for (const file of process.argv.slice(2)) {
  const img = decode(file);
  const counts = new Map();
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.stride + x * img.bpp;
      const k = (img.pixels[i] << 16) | (img.pixels[i + 1] << 8) | img.pixels[i + 2];
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, n]) => hex((k >> 16) & 255, (k >> 8) & 255, k & 255) + "=" + (100 * n / (img.w * img.h)).toFixed(1) + "%");
  const at = (x, y) => { const i = y * img.stride + x * img.bpp; return hex(img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]); };
  console.log(file.split(/[\\/]/).pop() + "  " + img.w + "x" + img.h + " bpp=" + img.bpp + " colors=" + counts.size);
  console.log("  top: " + top.join("  "));
  console.log("  px(300,60)=" + at(300, 60) + " px(6,100)=" + at(6, 100) + " px(300,300)=" + at(300, 300) + " px(600,300)=" + at(600, 300) + " px(1360,94)=" + at(1360, 94));
  // 文本像素占比：与背景差异明显的像素
  let dark = 0, total = 0;
  for (let y = 0; y < img.h; y += 2) { for (let x = 0; x < img.w; x += 2) { total++; } }
  console.log("  sampled=" + total);
}
