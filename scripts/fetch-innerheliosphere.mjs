/**
 * 构建期数据拉取：日–火区间（0.05–1.7 AU）太阳风的**实测精细结构**。
 * 输出 public/data/innerwind.json —— 运行时按需加载（只在开启「精细结构」时拉取）。
 * 用法：node scripts/fetch-innerheliosphere.mjs   （需外网；有按年缓存，中断后重跑只补缺口）
 *
 * 为什么这一段用实测：内日球层是唯一有**就地测量**的区域 ——
 *   PSP（Parker Solar Probe，0.046–1 AU，2018→） / Solar Orbiter（0.28–1 AU，2020→）
 *   / Helios 1、2（0.29–1 AU，1974–1986）。
 * 更远处从未被就地测量，绘制只能近似 —— 故本层严格限制在日–火区间。
 *
 * 数据源：NASA/GSFC CDAWeb HAPI 的合并 MAG+PLASMA 数据集（每行同时含位置与实测等离子体）：
 *   PSP_COHO1HR_MERGED_MAG_PLASMA / SOLO_COHO1HR_MERGED_MAG_PLASMA /
 *   HELIOS1_COHO1HR_MERGED_MAG_PLASMA / HELIOS2_COHO1HR_MERGED_MAG_PLASMA
 * 坐标：其 heliographicLongitude 经比对官方 PSP_HELIO1HR_POSITION 的 HGI_LON 完全一致
 *   （191.6 == 191.617），即**本身就是日心惯性系（HGI）**，无需自转相位换算。
 * 填充值：HAPI 缺测为 -1e31，须按值域剔除。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "data");
const CACHE_DIR = join(HERE, ".cache");

const HAPI = "https://cdaweb.gsfc.nasa.gov/hapi/data";
/** 日–火上边界：火星远日点 1.666 AU，留余量到 1.7 */
const R_MAX_AU = 1.7;
/** 采样间隔（小时）：风速结构以天为尺度，6 小时足以分辨快慢流 */
const SAMPLE_STEP_H = 6;

const SPACECRAFT = [
  { key: "psp", label: "Parker Solar Probe", ds: "PSP_COHO1HR_MERGED_MAG_PLASMA", from: 2018, to: 2026 },
  { key: "solo", label: "Solar Orbiter", ds: "SOLO_COHO1HR_MERGED_MAG_PLASMA", from: 2020, to: 2026 },
  { key: "helios1", label: "Helios 1", ds: "HELIOS1_COHO1HR_MERGED_MAG_PLASMA", from: 1974, to: 1981 },
  { key: "helios2", label: "Helios 2", ds: "HELIOS2_COHO1HR_MERGED_MAG_PLASMA", from: 1976, to: 1980 },
];

const JD_UNIX_EPOCH = 2440587.5;
const isoToJD = (iso) => Date.parse(iso) / 86400000 + JD_UNIX_EPOCH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 有效值：剔除 HAPI 的 -1e31 填充与明显越界 */
const valid = (x, lo, hi) => typeof x === "number" && Number.isFinite(x) && x > lo && x < hi;

async function fetchYear(sc, year, attempt = 1) {
  const url =
    `${HAPI}?id=${sc.ds}` +
    `&time.min=${year}-01-01T00:00:00Z&time.max=${year}-12-31T23:59:00Z&format=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.status && j.status.code >= 1400) throw new Error(j.status.message);
    const names = (j.parameters || []).map((p) => p.name);
    // 各数据集的坐标/风速字段名不同，按名取索引
    const ixR = names.findIndex((n) => /radialDistance|heliocentricDistance/i.test(n));
    const ixLat = names.findIndex((n) => /heliographicLatitude/i.test(n));
    const ixLon = names.findIndex((n) => /heliographicLongitude/i.test(n));
    const ixV = names.findIndex((n) => /ProtonSpeed|flowSpeed/i.test(n));
    const ixB = names.findIndex((n) => n === "B");
    if (ixR < 0 || ixV < 0 || ixLat < 0 || ixLon < 0) throw new Error("字段缺失：" + names.join(","));

    const out = [];
    let lastJd = -1e9;
    for (const row of j.data || []) {
      const r = row[ixR];
      const v = row[ixV];
      if (!valid(r, 0.01, R_MAX_AU) || !valid(v, 50, 3000)) continue;
      const lat = row[ixLat];
      const lon = row[ixLon];
      if (!valid(lat, -90, 90) || !valid(lon, -360, 720)) continue;
      const jd = isoToJD(row[0]);
      if (jd - lastJd < SAMPLE_STEP_H / 24) continue; // 降采样
      lastJd = jd;
      out.push([
        Number(jd.toFixed(4)),
        Number(r.toFixed(4)),
        Number(lat.toFixed(2)),
        Number(lon.toFixed(2)),
        Math.round(v),
        valid(row[ixB], 0, 20000) ? Number(row[ixB].toFixed(1)) : 0,
      ]);
    }
    return out;
  } catch (e) {
    if (attempt < 4) {
      await sleep(3000 * attempt);
      return fetchYear(sc, year, attempt + 1);
    }
    console.warn(`  ✗ ${sc.key} ${year} 年拉取失败：${e.message}`);
    return [];
  }
}

async function fetchYearCached(sc, year) {
  const file = join(CACHE_DIR, `inner-${sc.key}-${year}.json`);
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(rows) && rows.length > 0) return { rows, cached: true };
  } catch {
    /* 无缓存 */
  }
  const rows = await fetchYear(sc, year);
  if (rows.length) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(rows));
  }
  return { rows, cached: false };
}

console.log("═══ 拉取内日球层实测数据（PSP / Solar Orbiter / Helios 1,2）═══");
const series = {};
const failed = [];
for (const sc of SPACECRAFT) {
  const all = [];
  for (let y = sc.from; y <= sc.to; y++) {
    const { rows, cached } = await fetchYearCached(sc, y);
    all.push(...rows);
    if (!rows.length) failed.push(`${sc.key}:${y}`);
    if (!cached) await sleep(1500); // 礼貌间隔，避免被限流
  }
  series[sc.key] = all;
  const rr = all.map((s) => s[1]);
  console.log(
    `  ${sc.label.padEnd(20)} ${String(all.length).padStart(6)} 点` +
      (rr.length ? ` | r ${Math.min(...rr).toFixed(3)} → ${Math.max(...rr).toFixed(3)} AU` : " | 无数据"),
  );
}

const total = Object.values(series).reduce((a, s) => a + s.length, 0);
if (!total) throw new Error("全部数据集为空，终止");

mkdirSync(OUT_DIR, { recursive: true });
const out = {
  source: "NASA/GSFC CDAWeb HAPI — PSP / Solar Orbiter / Helios 1,2 合并 MAG+PLASMA（实测，HGI 日心惯性坐标）",
  note: "仅覆盖 0.05–1.7 AU（日–火）；此区间外无就地测量。bMag=0 表示缺测。",
  fields: ["jd", "rAU", "hgiLatDeg", "hgiLonDeg", "vKmS", "bMagNT"],
  sampleStepHours: SAMPLE_STEP_H,
  rMaxAU: R_MAX_AU,
  count: total,
  series,
};
const payload = JSON.stringify(out);
writeFileSync(join(OUT_DIR, "innerwind.json"), payload + "\n");

const vs = Object.values(series).flat().map((s) => s[4]);
console.log("═══ 结果 ═══");
console.log(`合计 ${total} 点；风速 ${Math.min(...vs)} → ${Math.max(...vs)} km/s（均值 ${(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(0)}）`);
console.log(`已写出 public/data/innerwind.json（${(payload.length / 1024).toFixed(0)} KB）`);
if (failed.length) console.log(`失败年份：${failed.join(",")}（重跑即可补齐，已缓存部分会跳过）`);
