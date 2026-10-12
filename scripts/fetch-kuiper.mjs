/**
 * 构建期数据拉取：柯伊伯带真实天体（JPL SBDB Query API，按轨道要素筛选 a >= 30 AU）。
 * 输出 public/data/kuiper.json —— 运行时异步加载。
 * 用法：node scripts/fetch-kuiper.mjs   （需外网；数据入库后离线可构建/可玩）
 *
 * 数据源：NASA/JPL Small-Body Database Query API
 *   https://ssd-api.jpl.nasa.gov/sbdb_query.api
 *   a >= 30 AU 即海王星轨道以外的天体（经典带 / 冥族 / 共振 / 散射盘 / 离散盘）；
 *   半人马天体 a < 30 AU 自动排除。
 * 说明：sb-group 参数只支持 neo/pha，故用 sb-cdata 按要素过滤。
 * 已单独建模的矮行星（冥王星/妊神星/鸟神星/阋神星）在此剔除，避免重复。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "data");

/** 已在主数据库单独建模、此处剔除的对象（按 full_name 子串匹配） */
const ALREADY_MODELED = ["Pluto", "Haumea", "Makemake", "Eris"];

/**
 * 剔除近抛物线的"闯入者"：a >= 30 AU 的要素筛选会带进大量 e≈1 的长周期天体，
 * 它们的半长轴没有物理意义（实测样本中最大达 1.6e6 AU），既不属于柯伊伯带，
 * 也会污染显示变换与相机 far 计算。已知最极端的离散盘天体（赛德娜 a=544、e=0.86）
 * 均在此范围内，故不影响任何公认的海外天体族群。
 */
const E_MAX = 0.99;
const A_MAX_AU = 1500;

const FIELDS = ["full_name", "a", "e", "i", "om", "w", "ma", "epoch", "per", "diameter"];

const url = new URL("https://ssd-api.jpl.nasa.gov/sbdb_query.api");
url.searchParams.set("fields", FIELDS.join(","));
url.searchParams.set("sb-cdata", JSON.stringify({ AND: ["a|GE|30"] }));
url.searchParams.set("limit", "20000");

console.log("查询 JPL SBDB：a >= 30 AU …");
const res = await fetch(url);
if (!res.ok) throw new Error(`SBDB HTTP ${res.status}`);
const j = await res.json();
if (!j.data) throw new Error(`SBDB 返回异常：${JSON.stringify(j).slice(0, 300)}`);

const idx = Object.fromEntries(FIELDS.map((f, k) => [f, k]));
const objects = [];
let skipped = 0;
let excluded = 0;
let recentEpoch = 0;

for (const row of j.data) {
  const name = row[idx.full_name] ?? "";
  if (ALREADY_MODELED.some((n) => name.includes(n))) {
    skipped++;
    continue;
  }
  const a = Number(row[idx.a]);
  const e = Number(row[idx.e]);
  const per = Number(row[idx.per]);
  const ep = Number(row[idx.epoch]);
  if (!Number.isFinite(a) || !Number.isFinite(e) || !Number.isFinite(per) || per <= 0) continue;
  if (!Number.isFinite(ep)) continue;
  if (!(e < E_MAX && a <= A_MAX_AU)) {
    excluded++;
    continue;
  }
  // SBDB 按「各自的最佳拟合历元」给出根数（多数为 2461200.5，少数较旧），
  // 逐条保留历元比统一换算到 J2000 少一次精度损失。
  if (Math.abs(ep - 2461200.5) < 730) recentEpoch++;
  const dm = Number(row[idx.diameter]);
  objects.push([
    Number(a.toFixed(5)),
    Number(e.toFixed(5)),
    Number(Number(row[idx.i]).toFixed(3)),
    Number(Number(row[idx.om]).toFixed(3)),
    Number(Number(row[idx.w]).toFixed(3)),
    Number(Number(row[idx.ma]).toFixed(3)),
    Math.round(per),
    ep,
    Number.isFinite(dm) ? Number(dm.toFixed(1)) : 0,
  ]);
}

const reported = Number(j.count);
if (reported !== j.data.length) {
  console.warn(`⚠ SBDB count=${reported} 但返回 ${j.data.length} 行，可能被 limit 截断`);
}

// 分箱统计（便于人工核对分布，非渲染逻辑）
const bins = { "a<39": 0, "39-40.5(3:2)": 0, "40.5-46": 0, "46-49.5(2:1)": 0, "49.5-55": 0, "a>=55": 0 };
let neptuneCrossing = 0;
for (const o of objects) {
  const [a, e] = o;
  if (a < 39) bins["a<39"]++;
  else if (a < 40.5) bins["39-40.5(3:2)"]++;
  else if (a < 46) bins["40.5-46"]++;
  else if (a < 49.5) bins["46-49.5(2:1)"]++;
  else if (a < 55) bins["49.5-55"]++;
  else bins["a>=55"]++;
  if (a * (1 - e) < 30) neptuneCrossing++;
}

mkdirSync(OUT_DIR, { recursive: true });
const out = {
  source: "NASA/JPL SBDB Query API",
  query: "a >= 30 AU",
  count: objects.length,
  fields: ["a", "e", "i", "om", "w", "ma", "per", "epochJD", "diameterKm"],
  objects,
};
writeFileSync(join(OUT_DIR, "kuiper.json"), JSON.stringify(out) + "\n");

const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`SBDB 返回 ${j.data.length} 条：剔除已建模 ${skipped} 条、近抛物线(e>=${E_MAX} 或 a>${A_MAX_AU}AU) ${excluded} 条 → 写入 ${objects.length} 条`);
console.log("半长轴分布:", bins, "| 近日点 <30AU（海王星交叉）:", neptuneCrossing);
console.log(`历元：${recentEpoch}/${objects.length} 条在 2461200.5±2 年内（其余为该天体自身拟合历元，逐条保留）`);
console.log(`已写出 public/data/kuiper.json（${kb} KB）`);
