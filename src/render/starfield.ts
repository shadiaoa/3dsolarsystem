/**
 * 真实星空（规格 §5：ESA Hipparcos 星表，构建期由 scripts/fetch-stars.mjs 打包为 public/data/stars.json）。
 *
 * - 坐标：赤道 J2000 (RA/Dec) → 黄道坐标 → 本项目 Three.js 轴约定（X=黄道x, Y=黄道z 北黄极, Z=−黄道y），
 *   与行星/轨道线共用同一坐标系，因此星空与黄道、行星位置天然对齐（地表观测时可见真实星座）。
 * - 尺寸：按星等分桶（PointsMaterial 不支持逐点尺寸，分桶即可，无需自定义着色器）。
 * - 颜色：B−V 色指数 → 有效温度（Ballesteros 2012）→ 黑体近似 RGB。
 * - 兜底：加载失败（离线）时保留程序化星空 —— 与贴图管线同样的「占位→异步替换」策略。
 */
import * as THREE from "three";

/** 黄赤交角（J2000），度 */
const OBLIQUITY_DEG = 23.4392911;
const DEG = Math.PI / 180;
/** 星空半径（与原先程序化星空一致，避免改变深度/near-far 行为） */
const STAR_RADIUS = 3800;

/** 星等分桶：边界与对应像素尺寸（越亮越大） */
const MAG_BINS: { maxMag: number; size: number }[] = [
  { maxMag: 1.0, size: 3.4 },
  { maxMag: 2.0, size: 2.7 },
  { maxMag: 3.0, size: 2.1 },
  { maxMag: 4.0, size: 1.7 },
  { maxMag: 5.0, size: 1.35 },
  { maxMag: Infinity, size: 1.05 },
];

/**
 * 赤道 J2000 → 本项目 Three.js 坐标（单位向量）。
 * Three 约定：X = 黄道 x，Y = 黄道 z（北黄极），Z = −黄道 y。
 */
export function equatorialToThree(raDeg: number, decDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const xEq = Math.cos(dec) * Math.cos(ra);
  const yEq = Math.cos(dec) * Math.sin(ra);
  const zEq = Math.sin(dec);
  const e = OBLIQUITY_DEG * DEG;
  const xe = xEq;
  const ye = yEq * Math.cos(e) + zEq * Math.sin(e);
  const ze = -yEq * Math.sin(e) + zEq * Math.cos(e);
  return out.set(xe, ze, -ye).normalize();
}

/** B−V 色指数 → 有效温度 K（Ballesteros 2012, EPL 97 34008） */
export function bvToKelvin(bv: number): number {
  const b = Math.min(2.0, Math.max(-0.4, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/** 有效温度 → 近似 RGB（黑体色，分段线性） */
const COLOR_STOPS: { t: number; c: [number, number, number] }[] = [
  { t: 2000, c: [1.0, 0.52, 0.22] },
  { t: 3500, c: [1.0, 0.75, 0.55] },
  { t: 5000, c: [1.0, 0.94, 0.86] },
  { t: 6500, c: [1.0, 0.99, 0.99] },
  { t: 8000, c: [0.90, 0.94, 1.0] },
  { t: 12000, c: [0.74, 0.84, 1.0] },
];

export function kelvinToRgb(t: number): [number, number, number] {
  const k = Math.min(COLOR_STOPS[COLOR_STOPS.length - 1].t, Math.max(COLOR_STOPS[0].t, t));
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const a = COLOR_STOPS[i - 1];
    const b = COLOR_STOPS[i];
    if (k <= b.t) {
      const f = (k - a.t) / (b.t - a.t);
      return [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f, a.c[2] + (b.c[2] - a.c[2]) * f];
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1].c;
}

/** 星等 → 相对亮度（仅用于抑制最暗星，避免它们显得与亮星等亮） */
function magBrightness(mag: number): number {
  return Math.min(1, Math.max(0.55, 1 - 0.09 * Math.max(0, mag - 1)));
}

/** 程序化占位星空（确定性伪随机；真实星表加载失败时使用） */
export function makeProceduralStars(count: number): THREE.Points {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < count; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = STAR_RADIUS * s * Math.cos(th);
    pos[i * 3 + 1] = STAR_RADIUS * u;
    pos[i * 3 + 2] = STAR_RADIUS * s * Math.sin(th);
    const b = 0.4 + rnd() * 0.6;
    const tint = rnd();
    col[i * 3] = b * (tint > 0.85 ? 1.0 : tint > 0.7 ? 0.9 : 0.82);
    col[i * 3 + 1] = b * 0.88;
    col[i * 3 + 2] = b * (tint > 0.7 ? 0.85 : 1.0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false });
  return new THREE.Points(geo, mat);
}

interface StarData {
  count: number;
  /** [raDeg, decDeg, vmag, bv] */
  stars: [number, number, number, number][];
}

/**
 * 用真实星表构建星点（按星等分桶，桶内保持与数据文件一致的顺序）。
 * 桶内顺序与数据顺序一致 —— 便于用「第 k 亮星」反查校验坐标。
 */
export function buildRealStars(data: StarData): THREE.Object3D[] {
  const buckets: { pos: number[]; col: number[] }[] = MAG_BINS.map(() => ({ pos: [], col: [] }));
  const v = new THREE.Vector3();

  for (const [ra, dec, mag, bv] of data.stars) {
    let bi = 0;
    while (bi < MAG_BINS.length - 1 && mag > MAG_BINS[bi].maxMag) bi++;
    equatorialToThree(ra, dec, v);
    const rgb = kelvinToRgb(bvToKelvin(bv));
    const br = magBrightness(mag);
    const b = buckets[bi];
    b.pos.push(v.x * STAR_RADIUS, v.y * STAR_RADIUS, v.z * STAR_RADIUS);
    b.col.push(rgb[0] * br, rgb[1] * br, rgb[2] * br);
  }

  return buckets
    .filter((b) => b.pos.length > 0)
    .map((b) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(b.pos), 3));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(b.col), 3));
      const size = MAG_BINS[buckets.indexOf(b)].size;
      const mat = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, depthWrite: false });
      return new THREE.Points(geo, mat);
    });
}

/**
 * 创建星空组：立即挂上程序化占位，异步加载真实星表后替换。
 * 返回的组可直接作为 kit.starfield 使用（唯一 API 是 visible 与整体重挂父节点）。
 */
export function createStarfield(proceduralCount = 6000): THREE.Group {
  const group = new THREE.Group();
  group.name = "starfield";
  const placeholder = makeProceduralStars(proceduralCount);
  group.add(placeholder);

  fetch(import.meta.env.BASE_URL + "data/stars.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<StarData>;
    })
    .then((data) => {
      if (!data?.stars?.length) throw new Error("星表为空");
      const real = buildRealStars(data);
      group.remove(placeholder);
      placeholder.geometry.dispose();
      (placeholder.material as THREE.Material).dispose();
      for (const p of real) group.add(p);
      group.userData.count = data.count;
      group.userData.magLimit = (data as unknown as { magLimit?: number }).magLimit;
      group.userData.real = true;
    })
    .catch(() => {
      /* 离线/缺文件：静默保留程序化星空 */
    });

  return group;
}
