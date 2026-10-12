/**
 * 构建期数据拉取（规格 §5）：JPL sbdb 全精度轨道根数 + 物理参数 → src/data/sbdb-snapshot.json。
 * 用法：node scripts/fetch-sbdb.mjs（需外网；快照入库后离线可构建）
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const TARGETS = [
  { id: "ceres", kind: "dwarf" },
  { id: "pluto", kind: "dwarf" },
  { id: "haumea", kind: "dwarf" },
  { id: "makemake", kind: "dwarf" },
  { id: "eris", kind: "dwarf" },
  { id: "1P", kind: "comet" },
  { id: "2P", kind: "comet" },
  { id: "67P", kind: "comet" },
  { id: "C/1995 O1", kind: "comet" },
  { id: "Bennu", kind: "asteroid" },
  { id: "Itokawa", kind: "asteroid" },
  { id: "Eros", kind: "asteroid" },
  // 著名海外天体（矮行星候选）：注册为完整天体 → 自动获得导航条目/轨道线/信息卡/可站上观测
  { id: "Quaoar", kind: "dwarf" },
  { id: "Orcus", kind: "dwarf" },
  { id: "Gonggong", kind: "dwarf" },
  { id: "Sedna", kind: "dwarf" },
  { id: "Arrokoth", kind: "dwarf" },
  { id: "Varuna", kind: "dwarf" },
  { id: "Ixion", kind: "dwarf" },
  { id: "Salacia", kind: "dwarf" },
  { id: "Varda", kind: "dwarf" },
  { id: "2018 VG18", kind: "dwarf" },
];

async function fetchBody(id) {
  const url = `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(id)}&full-prec=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const j = await res.json();
  const el = {};
  for (const x of j.orbit.elements) el[x.name] = x.value;
  const phys = {};
  for (const p of j.phys?.paris ?? []) phys[p.name] = p.value;
  return {
    epoch: Number(j.orbit.epoch),
    fullName: j.object?.full_name ?? id,
    elements: {
      a: Number(el.a), e: Number(el.e), i: Number(el.i),
      om: Number(el.om), w: Number(el.w), ma: Number(el.ma), per: Number(el.per),
    },
    phys: {
      diameterKm: phys.diameter ? Number(phys.diameter) : null,
      rotHours: phys.rot_per ? Number(phys.rot_per) : null,
    },
  };
}

const bodies = [];
for (const t of TARGETS) {
  try {
    const b = await fetchBody(t.id);
    bodies.push({ id: t.id, kind: t.kind, ...b });
    console.log(
      t.id.padEnd(12),
      "a=", String(b.elements.a).padEnd(10),
      "e=", String(b.elements.e).padEnd(9),
      "per=", String(b.elements.per).padEnd(12),
      "diam=", String(b.phys.diameterKm ?? "-").padEnd(8),
      "rot=", b.phys.rotHours ?? "-",
      "|", b.fullName,
    );
  } catch (e) {
    console.error(`✗ ${t.id}: ${e.message}`);
  }
}

writeFileSync(
  join(HERE, "..", "src", "data", "sbdb-snapshot.json"),
  JSON.stringify({ fetchedAt: new Date().toISOString(), source: "https://ssd-api.jpl.nasa.gov/sbdb.api (full-prec)", bodies }, null, 2) + "\n",
);
console.log("written src/data/sbdb-snapshot.json");
