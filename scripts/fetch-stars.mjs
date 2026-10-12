/**
 * 构建期数据拉取：真实星空（ESA Hipparcos 星表，VizieR I/239/hip_main）。
 * 输出 public/data/stars.json —— 运行时异步加载，失败则沿用程序化星空兜底。
 * 用法：node scripts/fetch-stars.mjs   （需外网；数据入库后离线可构建/可玩）
 *
 * 数据源：CDS VizieR 天文数据库（https://vizier.cds.unistra.fr），星表 I/239/hip_main
 *   —— ESA Hipparcos 天测星表（1989–1993 在轨测量，星等 Vmag、色指数 B-V、J2000 赤道坐标）
 * 过滤：Vmag <= MAG_LIMIT（默认 6.5，即肉眼可见极限）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "data");
const MAG_LIMIT = 6.5;

const URL_TSV =
  "https://vizier.cds.unistra.fr/viz-bin/asu-tsv" +
  "?-source=I/239/hip_main" +
  "&-out=HIP,_RAJ2000,_DEJ2000,Vmag,B-V" +
  "&-out.max=unlimited";

console.log("下载 Hipparcos 星表…（约 2.3 MB，需 20~60 秒）");
const res = await fetch(URL_TSV);
if (!res.ok) throw new Error(`VizieR HTTP ${res.status}`);
const tsv = await res.text();
console.log("已下载", (tsv.length / 1024 / 1024).toFixed(1), "MB");

// TSV 结构：# 注释若干行 → 表头 → 单位行 → 全 '-' 分隔行 → 数据
const lines = tsv.split(/\r?\n/);
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("---")) {
    start = i + 1;
    break;
  }
}
if (start < 0) throw new Error("未找到 TSV 数据分隔行，格式可能已变");

const stars = [];
let total = 0;
for (let i = start; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  const c = line.split("\t");
  if (c.length < 5) continue;
  const ra = Number(c[1]);
  const dec = Number(c[2]);
  const mag = Number(c[3]);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(mag)) continue;
  total++;
  if (mag > MAG_LIMIT) continue;
  const bv = Number(c[4]);
  // RA/Dec 5 位小数（≈0.036″，远优于需求）；B-V 缺测以 0.65（类太阳白）兜底
  stars.push([
    Number(ra.toFixed(5)),
    Number(dec.toFixed(5)),
    Number(mag.toFixed(2)),
    Number.isFinite(bv) ? Number(bv.toFixed(3)) : 0.65,
  ]);
}

stars.sort((a, b) => a[2] - b[2]); // 按亮度排序，便于渲染端分桶

mkdirSync(OUT_DIR, { recursive: true });
const out = {
  source: "ESA Hipparcos (VizieR I/239/hip_main)",
  epoch: "J2000",
  magLimit: MAG_LIMIT,
  count: stars.length,
  fetchedAt: new Date().toISOString(),
  // [raDeg, decDeg, vmag, bv]
  stars,
};
writeFileSync(join(OUT_DIR, "stars.json"), JSON.stringify(out) + "\n");

const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`可解析恒星 ${total} 颗 → Vmag<=${MAG_LIMIT} 保留 ${stars.length} 颗`);
console.log(`已写出 public/data/stars.json（${kb} KB）`);
