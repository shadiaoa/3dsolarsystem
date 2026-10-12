/**
 * 柯伊伯带点云（真实天体）：数据由 scripts/fetch-kuiper.mjs 自 JPL SBDB 拉取
 * （a >= 30 AU，约 8000 条，逐条含各自历元的轨道根数），打包为 public/data/kuiper.json。
 *
 * - 位置：由历元根数直接解算 M = ma + n·(jd − epoch) → 开普勒 → 日心黄道坐标（AU），
 *   与行星/轨道线共用同一显示变换（观赏幂压缩 / 真实 km），故与海王星、冥王星严丝合缝。
 * - 着色：按动力学分类（标准划分法）—— 冥族(3:2)、2:1 共振、其他共振、经典带、散射盘、离散盘。
 * - 性能：海外天体周期 ≥ 100 年，一天内角位移远小于 1 像素，故位置按「|Δjd| ≥ 1 天」刷新。
 * - 精度：与主带同策略 —— 几何存「位置−原点」，对象位置 = 原点，对抗 float32 顶点精度。
 */
import * as THREE from "three";
import { solveKepler } from "../core/kepler";
import { toDisplay, KM_PER_AU } from "./scale";

const DEG = Math.PI / 180;

/**
 * 主要海王星共振半长轴（AU）。
 * 只收录取向分隔良好的共振：3:2 冥族(39.4)、2:1(47.8)、5:2(55.4)、3:1(62.5)。
 * 42~44 AU 一带并列着 5:3/4:3/7:4 三条共振，仅凭半长轴无法可靠区分
 * （严格判定需检验共振幅角的平动 libration），故不纳入以免把经典带误判为共振。
 */
const RESONANCES: { a: number; name: ClassName }[] = [
  { a: 39.4, name: "plutino" },
  { a: 47.8, name: "twotino" },
  { a: 55.4, name: "other" },
  { a: 62.5, name: "other" },
];
const RES_TOL_AU = 0.6;

type ClassName = "plutino" | "twotino" | "other" | "classical" | "scattered" | "detached";

/** 各动力学分类的颜色（十六进制） */
const CLASS_COLOR: Record<ClassName, number> = {
  plutino: 0x7fb4ff,
  twotino: 0x5fd0c4,
  other: 0xb08cff,
  classical: 0xd9d3c2,
  scattered: 0xff9a6a,
  detached: 0xff6a8a,
};

const CLASS_LABEL: Record<ClassName, string> = {
  plutino: "冥族天体（3:2 共振）",
  twotino: "2:1 共振",
  other: "其他共振（5:2 / 3:1）",
  classical: "经典柯伊伯带",
  scattered: "散射盘",
  detached: "离散盘",
};

/**
 * 动力学划分（近似）：仅用 (a, e) 判定。
 * 严格分类需检验共振幅角平动与长期积分，此处用于可视化着色，量级与主流划分一致：
 *   共振 → 冥族/2:1/其他共振；近日点在海外且轨道大 → 离散盘；与海王星交叉 → 散射盘；其余 → 经典带。
 */
function classify(a: number, e: number): ClassName {
  for (const r of RESONANCES) {
    if (Math.abs(a - r.a) < RES_TOL_AU) return r.name;
  }
  const q = a * (1 - e);
  if (q < 30) return "scattered";
  if (q > 40 && a > 50) return "detached";
  if (a < 48) return "classical";
  return "scattered";
}

interface KuiperData {
  count: number;
  fields: string[];
  /** [a, e, i, om, w, ma, per, epochJD, diameterKm] */
  objects: number[][];
}

export class KuiperBelt {
  readonly points: THREE.Points;
  /** 数据中的最远半长轴（AU）：用于真实比例下放宽相机 far */
  maxAU = 50;

  private n = 0;
  private a!: Float64Array;
  private e!: Float64Array;
  private inc!: Float64Array;
  private node!: Float64Array;
  private peri!: Float64Array;
  private m0!: Float64Array;
  private epoch!: Float64Array;
  private nRad!: Float64Array;

  private ready = false;
  private lastJd = NaN;
  private lastOriginKey = "";

  /** 分类统计（供信息展示/调试） */
  classCounts: Partial<Record<ClassName, number>> = {};

  constructor(world: THREE.Object3D) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.PointsMaterial({
      size: 1.5, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 0.9, depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    world.add(this.points);

    fetch(import.meta.env.BASE_URL + "data/kuiper.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<KuiperData>;
      })
      .then((data) => this.build(data))
      .catch(() => {
        /* 离线/缺文件：该层保持为空 */
      });
  }

  private build(data: KuiperData) {
    const objs = data.objects ?? [];
    this.n = objs.length;
    if (!this.n) return;

    this.a = new Float64Array(this.n);
    this.e = new Float64Array(this.n);
    this.inc = new Float64Array(this.n);
    this.node = new Float64Array(this.n);
    this.peri = new Float64Array(this.n);
    this.m0 = new Float64Array(this.n);
    this.epoch = new Float64Array(this.n);
    this.nRad = new Float64Array(this.n);

    const colors = new Float32Array(this.n * 3);
    let maxA = 0;
    const counts: Partial<Record<ClassName, number>> = {};

    for (let k = 0; k < this.n; k++) {
      const o = objs[k];
      const a = o[0];
      const e = o[1];
      this.a[k] = a;
      this.e[k] = e;
      this.inc[k] = o[2] * DEG;
      this.node[k] = o[3] * DEG;
      this.peri[k] = o[4] * DEG;
      this.m0[k] = o[5] * DEG;
      this.epoch[k] = o[7];
      this.nRad[k] = (2 * Math.PI) / o[6]; // per 为周期（天）
      if (a > maxA) maxA = a;

      const cls = classify(a, e);
      counts[cls] = (counts[cls] ?? 0) + 1;
      const c = new THREE.Color(CLASS_COLOR[cls]);
      colors[k * 3] = c.r;
      colors[k * 3 + 1] = c.g;
      colors[k * 3 + 2] = c.b;
    }

    this.maxAU = maxA;
    this.classCounts = counts;

    const geo = this.points.geometry;
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    this.ready = true;
    this.lastJd = NaN; // 强制下一帧算一次
  }

  /** 分类说明（用于图例/信息展示） */
  static label(cls: ClassName): string {
    return CLASS_LABEL[cls];
  }

  setVisible(v: boolean) {
    this.points.visible = v;
  }

  update(jd: number, origin: THREE.Vector3, trueMode: boolean) {
    if (!this.points.visible || !this.ready) return;
    const originKey = `${origin.x}|${origin.y}|${origin.z}|${trueMode ? 1 : 0}`;
    const originChanged = originKey !== this.lastOriginKey;
    // 海外天体移动极慢：一天内角位移远小于 1 像素，无需每帧重算
    if (!originChanged && Math.abs(jd - this.lastJd) < 1.0) return;
    this.lastJd = jd;
    this.lastOriginKey = originKey;

    const attr = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const n = this.n;

    for (let k = 0; k < n; k++) {
      const e = this.e[k];
      const M = this.m0[k] + this.nRad[k] * (jd - this.epoch[k]);
      const E = solveKepler(M, e);
      const r = this.a[k] * (1 - e * Math.cos(E));
      const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
      const xp = r * Math.cos(nu);
      const yp = r * Math.sin(nu);
      const iR = this.inc[k], nodeR = this.node[k];
      const wR = this.peri[k] - nodeR;
      const cw = Math.cos(wR), sw = Math.sin(wR);
      const cO = Math.cos(nodeR), sO = Math.sin(nodeR);
      const ci = Math.cos(iR), si = Math.sin(iR);
      const xe = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
      const ye = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
      const ze = sw * si * xp + cw * si * yp;
      if (trueMode) {
        arr[k * 3] = xe * KM_PER_AU - origin.x;
        arr[k * 3 + 1] = ze * KM_PER_AU - origin.y;
        arr[k * 3 + 2] = -ye * KM_PER_AU - origin.z;
      } else {
        toDisplay(xe, ze, -ye, _v);
        arr[k * 3] = _v.x;
        arr[k * 3 + 1] = _v.y;
        arr[k * 3 + 2] = _v.z;
      }
    }
    attr.needsUpdate = true;
    this.points.position.copy(origin);
  }
}

const _v = new THREE.Vector3();
