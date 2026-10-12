/**
 * 构建期数据拉取：太阳风结构层参数（逐卡林顿周）。
 * 输出 public/data/solarwind.json —— 运行时异步加载，缺失时该层不显示。
 * 用法：node scripts/fetch-solarwind.mjs   （需外网，约 10 分钟；数据入库后离线可构建/可玩）
 *
 * 数据源（均为实测/权威）：
 *  A) NASA/GSFC OMNI2 小时数据（CDAWeb HAPI，数据集 OMNI2_H0_MRG1HR，覆盖 1963→今）
 *     风速 V1800 / 质子密度 N1800 / 行星际磁场强度 ABS_B1800 / BZ_GSE1800 / F10.7 指数
 *     → 聚合为逐卡林顿周均值。OMNI 是由多颗航天器（含 L1 点的 ACE/DSCOVR）合并校正的近地太阳风数据库。
 *  B) Wilcox 太阳天文台（WSO）日球电流片倾角表（http://wso.stanford.edu/Tilts.html，1976→今）
 *     取经典模型（line-of-sight）的平均最大纬度伸展 L_av 作为倾角 α。
 *     官方说明：>70° 的值为下限（模型不在此之上计算）。
 *
 * 注意：HAPI 要求参数**按数据集定义的规范顺序**请求，否则报 1411 Parameter out of order；
 *       且列索引必须依据响应里的 parameters 数组，不能假设顺序。
 *       CDAWeb 会限流：脚本已加请求间隔与按年磁盘缓存（scripts/.cache/），被中断时重跑即可补齐。
 *       输出中 bMag/bx/bz/n 为 0 表示该卡林顿周缺有效实测（上游填充值已剔除），非真实零值。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "data");
/** 按年缓存：CDAWeb/NOAA 偶发连不上，缓存后重跑只需补失败年份 */
const CACHE_DIR = join(HERE, ".cache");

const HAPI = "https://cdaweb.gsfc.nasa.gov/hapi/data";
const DATASET = "OMNI2_H0_MRG1HR";
/** 必须按 OMNI2_H0_MRG1HR 的规范顺序（ABS_B=6, BX_GSE=10, BZ_GSE=12, N=21, V=22, F10=45） */
const PARAMS = ["ABS_B1800", "BX_GSE1800", "BZ_GSE1800", "N1800", "V1800", "F10_INDEX1800"];
const YEAR_FROM = 1963;
const YEAR_TO = new Date().getUTCFullYear();
const CR_PERIOD_DAYS = 27.2753; // 卡林顿周（官方定义值）

const JD_UNIX_EPOCH = 2440587.5;

function isoToJD(iso) {
  return Date.parse(iso) / 86400000 + JD_UNIX_EPOCH;
}
function jdToYMD(jd) {
  const d = new Date((jd - JD_UNIX_EPOCH) * 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────── A) OMNI2 小时数据 ───────────────── */

/** 合理值域过滤：OMNI 以 999.9/9999 等填充缺测值，必须剔除，否则会污染卡林顿周均值 */
const sane = (x, lo, hi) => typeof x === "number" && Number.isFinite(x) && x > lo && x < hi;

async function fetchYear(year, attempt = 1) {
  const url =
    `${HAPI}?id=${DATASET}` +
    `&time.min=${year}-01-01T00:00:00Z&time.max=${year}-12-31T23:59:00Z` +
    `&parameters=${PARAMS.join(",")}&format=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.status && j.status.code >= 1400) throw new Error(j.status.message);
    const names = (j.parameters || []).map((p) => p.name);
    const ix = {
      b: names.indexOf("ABS_B1800"),
      bx: names.indexOf("BX_GSE1800"),
      bz: names.indexOf("BZ_GSE1800"),
      n: names.indexOf("N1800"),
      v: names.indexOf("V1800"),
      f: names.indexOf("F10_INDEX1800"),
    };
    if (ix.b < 0 || ix.v < 0) throw new Error("参数缺失：" + names.join(","));
    const out = [];
    for (const row of j.data || []) {
      const v = row[ix.v];
      if (!sane(v, 0, 3000)) continue;
      out.push({
        jd: isoToJD(row[0]),
        v,
        n: sane(row[ix.n], 0, 200) ? row[ix.n] : NaN,
        // 1 AU 处 IMF 实测极少超过 40 nT（极端事件），故上限取 60 兼作填充值剔除
        b: sane(row[ix.b], 0, 60) ? row[ix.b] : NaN,
        bx: sane(row[ix.bx], -60, 60) ? row[ix.bx] : NaN,
        bz: sane(row[ix.bz], -60, 60) ? row[ix.bz] : NaN,
        f: sane(row[ix.f], 0, 10000) ? row[ix.f] : NaN,
      });
    }
    return out;
  } catch (e) {
    if (attempt < 4) {
      await sleep(3000 * attempt);
      return fetchYear(year, attempt + 1);
    }
    console.warn(`  ✗ ${year} 年拉取失败：${e.message}`);
    return [];
  }
}

/** 带磁盘缓存的按年拉取 */
async function fetchYearCached(year) {
  const file = join(CACHE_DIR, `omni-${year}.json`);
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(rows) && rows.length > 0) return { rows, cached: true };
  } catch {
    /* 无缓存 */
  }
  const rows = await fetchYear(year);
  if (rows.length) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(rows));
  }
  return { rows, cached: false };
}

/* ───────────────── B) WSO 电流片倾角 ───────────────── */

async function fetchTilts(attempt = 1) {
  try {
    const res = await fetch("http://wso.stanford.edu/Tilts.html", { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`WSO HTTP ${res.status}`);
    const html = await res.text();
    const out = [];
    // 形如：CR 1642  1976:05:27 15h	  6.8	 4.7	-9.0	14.5	13.6	-15.5
    const re = /^CR\s+(\d+)\s+(\d{4}):(\d{2}):(\d{2})\s+(\d{1,2})h\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/gm;
    let m;
    while ((m = re.exec(html)) !== null) {
      const [, cr, y, mo, dd, hh, , , , lAv, lN, lS] = m;
      const iso = `${y}-${mo}-${dd}T${String(hh).padStart(2, "0")}:00:00Z`;
      out.push({
        cr: Number(cr),
        startJD: isoToJD(iso),
        tilt: Number(lAv),   // 经典模型平均最大纬度伸展
        tiltN: Number(lN),
        tiltS: Number(lS),
      });
    }
    if (!out.length) throw new Error("未解析到倾角行");
    return out;
  } catch (e) {
    if (attempt < 4) {
      await sleep(3000 * attempt);
      return fetchTilts(attempt + 1);
    }
    console.warn(`  ✗ WSO 倾角拉取失败：${e.message} —— 电流片倾角将标记为缺失（按 10° 示意）`);
    return [];
  }
}

/* ───────────────── 主流程 ───────────────── */

console.log("═══ A) 拉取 OMNI2 小时数据（逐年，1963→今；有缓存则跳过）═══");
const samples = [];
const failedYears = [];
for (let y = YEAR_FROM; y <= YEAR_TO; y++) {
  const { rows, cached } = await fetchYearCached(y);
  samples.push(...rows);
  if (!rows.length) failedYears.push(y);
  process.stdout.write(`  ${y}: ${rows.length} 条${cached ? "（缓存）" : ""}\n`);
  if (!cached) await sleep(1500); // 礼貌间隔：连发请求会被 CDAWeb 限流（实测后段年份集体失败）
}
console.log(`OMNI 合计 ${samples.length} 条小时样本${failedYears.length ? `；失败年份 ${failedYears.join(",")}（该区间卡林顿周参数将有缺口）` : ""}`);
if (!samples.length) throw new Error("OMNI 数据为空，终止");

console.log("═══ B) 拉取 WSO 电流片倾角 ═══");
const tilts = await fetchTilts();
if (tilts.length) {
  console.log(`WSO 倾角 ${tilts.length} 个卡林顿周（CR ${tilts[0].cr} → ${tilts[tilts.length - 1].cr}）`);
} else {
  console.log("WSO 倾角缺失，全部标记为 -1（渲染端按 10° 示意）");
}

// 用 WSO 表自身的间隔校验卡林顿周周期（自证）
if (tilts.length > 3) {
  const spans = [];
  for (let i = 1; i < Math.min(tilts.length, 60); i++) spans.push(tilts[i].startJD - tilts[i - 1].startJD);
  const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
  console.log(`  由 WSO 表反推卡林顿周周期 = ${mean.toFixed(4)} 天（定义值 ${CR_PERIOD_DAYS}）`);
}

// 把 OMNI 样本按卡林顿周分箱：以 WSO 第一个 CR 为锚（缺失时用 1976-05-27 兜底），
// 向前后按周期外推，覆盖 1963→今
const anchor = tilts.length
  ? { cr: tilts[0].cr, startJD: tilts[0].startJD }
  : { cr: 1642, startJD: isoToJD("1976-05-27T15:00:00Z") };
const crOf = (jd) => anchor.cr + Math.floor((jd - anchor.startJD) / CR_PERIOD_DAYS);
const tiltByCr = new Map(tilts.map((t) => [t.cr, t]));

const bins = new Map(); // cr -> { sumV, sumN, sumB, sumBz, sumF, cnt*, startJD }
let rejected = 0;
for (const s of samples) {
  const cr = crOf(s.jd);
  let bin = bins.get(cr);
  if (!bin) {
    bin = { cr, startJD: anchor.startJD + (cr - anchor.cr) * CR_PERIOD_DAYS, v: 0, n: 0, b: 0, bx: 0, bz: 0, f: 0, cv: 0, cn: 0, cb: 0, cf: 0 };
    bins.set(cr, bin);
  }
  bin.v += s.v; bin.cv++;
  // 值域过滤在此再查一遍：缓存里可能残留早期未过滤的填充值（999.9 等），
  // 挡在聚合层可保证「改过滤规则后仅靠缓存即可秒级重跑」。
  if (sane(s.n, 0, 200)) { bin.n += s.n; bin.cn++; }
  if (sane(s.b, 0, 60)) { bin.b += s.b; bin.cb++; }
  if (sane(s.bx, -60, 60)) bin.bx += s.bx;
  if (sane(s.bz, -60, 60)) bin.bz += s.bz;
  if (sane(s.f, 0, 10000)) { bin.f += s.f; bin.cf++; }
  if (bin.cv > 1200) rejected++; // 单周样本上限保护
}

const rotations = [...bins.values()]
  .filter((b) => b.cv >= 24) // 至少一天的有效样本
  .sort((a, b) => a.cr - b.cr)
  .map((b) => {
    const t = tiltByCr.get(b.cr);
    return [
      Number(b.startJD.toFixed(3)),
      Number((b.v / b.cv).toFixed(1)),                       // 平均风速 km/s
      b.cn ? Number((b.n / b.cn).toFixed(2)) : 0,             // 平均质子密度 /cc
      b.cb ? Number((b.b / b.cb).toFixed(2)) : 0,             // 平均 |B| nT
      Number((b.bx / b.cv).toFixed(2)),                       // 平均 Bx（GSE）：扇形极性的符号来源
      Number((b.bz / b.cv).toFixed(2)),                       // 平均 Bz（GSE）nT
      b.cf ? Number((b.f / b.cf).toFixed(1)) : 0,             // F10.7
      t ? t.tilt : -1,                                        // 电流片倾角（-1 = 无 WSO 数据）
    ];
  });

mkdirSync(OUT_DIR, { recursive: true });
const out = {
  source: "NASA/GSFC OMNI2 (CDAWeb HAPI) + WSO HCS tilt",
  fields: ["startJD", "v", "n", "bMag", "bx", "bz", "f107", "tilt"],
  units: ["JD", "km/s", "1/cc", "nT", "nT", "nT", "sfu", "deg"],
  count: rotations.length,
  rotations,
};
const payload = JSON.stringify(out);
writeFileSync(join(OUT_DIR, "solarwind.json"), payload + "\n");

const tiltVals = rotations.map((r) => r[7]).filter((x) => x >= 0);
console.log("═══ 结果 ═══");
console.log(`卡林顿周数 ${rotations.length}（${jdToYMD(rotations[0][0])} → ${jdToYMD(rotations[rotations.length - 1][0])}）`);
if (tiltVals.length) {
  console.log(`倾角可用 ${tiltVals.length} 期，范围 ${Math.min(...tiltVals).toFixed(1)}° → ${Math.max(...tiltVals).toFixed(1)}°`);
} else {
  console.log("倾角全部缺失");
}
const vs = rotations.map((r) => r[1]);
console.log(`风速均值 ${(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1)} km/s`);
console.log(`已写出 public/data/solarwind.json（${(payload.length / 1024).toFixed(0)} KB）`);
