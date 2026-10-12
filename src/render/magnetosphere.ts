/**
 * 太阳风–地球磁层相互作用（**理想 MHD 示意图**，非实景）。
 *
 * 尺寸由**实测太阳风**驱动（Dp 与 IMF Bz 来自本项目的 OMNI 层），形状取公开发表的经验模型：
 *   · 磁层顶：Shue et al. 1998（JGR 103, 17691）低纬经验模型
 *       r(θ) = r₀·(2/(1+cosθ))^α ，  θ = 与日地连线的夹角
 *       r₀ = (10.22 + 1.29·tanh[0.184(Bz + 8.14)]) · Dp^(−1/6.6)   [R_E]
 *       α  = (0.58 − 0.007·Bz) · (1 + 0.024·ln Dp)
 *     典型 Dp=2 nPa、Bz=0 → r₀ ≈ 10.25 R_E（教科书值 10）；极端 Dp=20、Bz=−20 → ≈5.7 R_E。
 *   · 弓激波：Farris & Russell 1994 的日下点定标（Rankine–Hugoniot 推出）
 *       r_bs/r_mp = 1 + 1.1·[(γ−1)M² + 2]/[(γ+1)M²] ，  γ=5/3，M = 磁声马赫数
 *     取与磁层顶同族形状按此比例放大（**示意的通行做法**；真实弓激波形状受马赫数与 IMF 取向影响，
 *     各模型差异较大，见 Cairns & Lyon 1996 / Verigin et al. 2001）。
 *   · 磁尾：观测延伸至 >200 R_E，此处画到 200 R_E 后截断。
 *
 * 取向：鼻端朝向真实的太阳方向（随地球公转改变）；边界形状固定于日地连线，而偶极磁场随地球自转共转。
 * 说明：声速需等离子体温度，本项目未采集，故取典型 T = 1×10⁵ K（灵敏度低：
 *   T 差 2 倍仅使 M 变约 15%、弓激波日下点变约 3%）。
 */
import * as THREE from "three";
import type { SimBody } from "./bodies";
import { spinAngle } from "./bodies";

const DEG = Math.PI / 180;
/** 动压：nPa = 1.6726e-6 · n[cm^-3] · v[km/s]² */
const P_DYN = 1.6726e-6;
const GAMMA = 5 / 3;
const T_SOUND_K = 1.0e5;
/** 尾长（R_E） */
const TAIL_LEN = 200;
/** 边界曲面在尾向的截断角与截断半径上限（R_E） */
const THETA_LIM = 125 * DEG;
/** 偶极轴相对自转轴的偏移（真实约 11.5°） */
const DIPOLE_OFFSET = 11.5 * DEG;

const COLOR_MP = 0x5fc8ff;      // 磁层顶
const COLOR_BS = 0xff8a5c;      // 弓激波
const COLOR_FIELD = 0x7ef0c0;   // 偶极磁场线
const COLOR_FLOW = 0xcfe2ff;    // 太阳风来流
const COLOR_IMF = 0xffd479;     // 行星际磁场（被"披盖"）

export interface SolarWindInput {
  n: number;   // 质子密度 /cc
  v: number;   // 风速 km/s
  b: number;   // IMF 强度 nT
  bz: number;  // IMF Bz (GSE) nT
}

/** 动压 nPa */
export function dynamicPressure(n: number, v: number): number {
  return P_DYN * Math.max(0, n) * Math.max(0, v) * Math.max(0, v);
}

/** 磁声马赫数：v / sqrt(v_A² + c_s²) */
export function magnetosonicMach(v: number, n: number, b: number): number {
  const vA = (21.8 * b) / Math.sqrt(Math.max(0.01, n)); // km/s
  const cs = 37.09 * Math.sqrt(T_SOUND_K / 1e5);        // km/s
  const vms = Math.sqrt(vA * vA + cs * cs);
  return v / Math.max(1, vms);
}

/** Shue 1998 磁层顶：日下点距离与张角（R_E） */
export function magnetopauseParams(dp: number, bz: number): { r0: number; alpha: number } {
  const d = Math.max(0.1, dp);
  const r0 = (10.22 + 1.29 * Math.tanh(0.184 * (bz + 8.14))) * Math.pow(d, -1 / 6.6);
  const alpha = (0.58 - 0.007 * bz) * (1 + 0.024 * Math.log(d));
  return { r0, alpha };
}

/** Farris & Russell 1994：弓激波日下点 / 磁层顶日下点 */
export function bowShockRatio(mms: number): number {
  const m2 = Math.max(1.001, mms * mms);
  return 1 + (1.1 * ((GAMMA - 1) * m2 + 2)) / ((GAMMA + 1) * m2);
}

/** 由 (r0, α) 生成形状函数 r(θ)（θ 从鼻端算起） */
function shaper(r0: number, alpha: number) {
  return (theta: number) => r0 * Math.pow(2 / (1 + Math.cos(Math.min(theta, Math.PI - 1e-3))), alpha);
}

interface Frame {
  r0mp: number;
  r0bs: number;
  alpha: number;
  mms: number;
  dp: number;
}

export class MagnetosphereLayer {
  readonly group: THREE.Group;
  /** 随地球自转共转的偶极磁场线 */
  private dipoleGroup = new THREE.Group();
  private surfaces = new THREE.Group();
  private windGroup = new THREE.Group();
  private windKey = "";
  private frameInfo: Frame | null = null;

  constructor(world: THREE.Object3D) {
    this.group = new THREE.Group();
    this.group.name = "magnetosphere";
    this.group.add(this.surfaces, this.dipoleGroup, this.windGroup);
    this.group.visible = false;
    world.add(this.group);
  }

  /** 当前用于展示的尺度信息（供界面读数） */
  get info(): { r0mp: number; r0bs: number; dp: number; mms: number } | null {
    return this.frameInfo;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  /**
   * 每帧：位置与尺度锚定地球（1 R_E = 地球当前显示半径），鼻端朝向真实太阳方向；
   * 偶极磁场线随地球自转共转，边界曲面不共转。
   */
  update(earth: SimBody, sunDispPos: THREE.Vector3, dJ2000: number, wind: SolarWindInput | null) {
    if (!this.group.visible || !wind) return;

    // 尺度：1 R_E = 地球显示半径 ⇒ 观赏模式随地球夸张比例一起放大，真实模式即 6378 km（物理正确）。
    // 位置用 dispPos：本组挂在 kit.world 下，该组在真实比例下带 −原点 偏移。
    this.group.position.copy(earth.dispPos);
    this.group.scale.setScalar(earth.dispR);

    // 取向：本地 +x 指向太阳
    _dir.copy(sunDispPos).sub(earth.dispPos);
    if (_dir.lengthSq() < 1e-12) _dir.set(1, 0, 0);
    _dir.normalize();
    this.group.quaternion.setFromUnitVectors(LOCAL_X, _dir);

    // 偶极磁场线：随地球自转（含 11.5° 偶极偏移与 23.44° 自转轴倾角）
    this.dipoleGroup.quaternion.setFromAxisAngle(
      LOCAL_X,
      spinAngle(earth, dJ2000) + (earth.axialTiltDeg * DEG) + DIPOLE_OFFSET,
    );

    // 缺失读数（上游填充值已剔除，界面显示为「—」）用典型值兜底，避免动压/马赫数失真：
    // 1 AU 处典型质子密度 ≈5 /cc、|B| ≈5 nT
    const n = wind.n > 0 ? wind.n : 5;
    const b = wind.b > 0 ? wind.b : 5;
    const dp = dynamicPressure(n, wind.v);
    const mms = magnetosonicMach(wind.v, n, b);
    const { r0, alpha } = magnetopauseParams(dp, wind.bz);
    const r0bs = r0 * bowShockRatio(mms);
    this.frameInfo = { r0mp: r0, r0bs, alpha, mms, dp };

    const windKey = `${dp.toFixed(3)}|${wind.bz.toFixed(2)}`;
    if (windKey !== this.windKey) {
      this.windKey = windKey;
      this.build(r0, alpha, r0bs);
    }
  }

  private clearGroup(g: THREE.Group) {
    for (const c of g.children) {
      const mesh = c as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      mat?.dispose();
    }
    g.clear();
  }

  private build(r0mp: number, alpha: number, r0bs: number) {
    this.clearGroup(this.surfaces);
    this.clearGroup(this.windGroup);
    this.clearGroup(this.dipoleGroup);

    const fmp = shaper(r0mp, alpha);
    const fbs = shaper(r0bs, alpha);
    const rCapMp = Math.min(fmp(THETA_LIM), 40);
    const rCapBs = Math.min(fbs(THETA_LIM), 55);
    // 曲面（统一绕日地连线旋转：方位对称，为一阶近似）
    this.surfaces.add(this.makeSurface(fmp, rCapMp, COLOR_MP, 0.14));
    this.surfaces.add(this.makeSurface(fbs, rCapBs, COLOR_BS, 0.12));

    // 尾向圆柱（磁尾）：θ_LIM 处 x 为负（下游），由此延伸到尾长
    const xLimMp = rLim(fmp, rCapMp, THETA_LIM) * Math.cos(THETA_LIM);
    this.surfaces.add(this.makeCylinder(xLimMp, rCapMp, -TAIL_LEN, COLOR_MP, 0.10));
    const xLimBs = rLim(fbs, rCapBs, THETA_LIM) * Math.cos(THETA_LIM);
    this.surfaces.add(this.makeCylinder(xLimBs, rCapBs, -TAIL_LEN, COLOR_BS, 0.07));

    // 偶极磁场线：逐条裁剪到磁层顶内
    for (const L of [1.4, 1.8, 2.4, 3.0, 3.8, 4.8, 6.0, 7.4, 9.0]) {
      for (let a = 0; a < 10; a++) {
        const phi = (a / 10) * Math.PI * 2;
        const line = this.dipoleLine(L, phi, fmp, rCapMp);
        if (line) this.dipoleGroup.add(line);
      }
    }
    // 极区开放线：沿磁尾向下游拉伸（示意）
    for (let a = 0; a < 6; a++) {
      const phi = (a / 6) * Math.PI * 2;
      this.dipoleGroup.add(this.tailLine(phi, rCapMp));
    }

    // 太阳风来流：按 b = max(b, 弓激波截面半径) 挠过激波
    for (const bImp of [0, 4, 8, 12, 18, 26, 36, 48]) {
      this.windGroup.add(this.streamLine(bImp, fbs, rCapBs, COLOR_FLOW, 0.5));
      this.windGroup.add(this.streamLine(bImp + 2, fbs, rCapBs, COLOR_IMF, 0.42, -14));
    }
  }

  /** 绕日地连线旋转的回转面（尾向以圆柱收尾） */
  private makeSurface(f: (t: number) => number, rCap: number, color: number, opacity: number): THREE.Object3D {
    const NS = 26;
    const NP = 60;
    const verts: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= NS; i++) {
      const theta = (i / NS) * THETA_LIM;
      const r = Math.min(f(theta), rCap);
      const x = r * Math.cos(theta);
      const rho = r * Math.sin(theta);
      for (let j = 0; j < NP; j++) {
        const phi = (j / NP) * Math.PI * 2;
        verts.push(x, rho * Math.cos(phi), rho * Math.sin(phi));
      }
    }
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NP; j++) {
        const a = i * NP + j;
        const b = i * NP + ((j + 1) % NP);
        const c = (i + 1) * NP + j;
        const d = (i + 1) * NP + ((j + 1) % NP);
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    return m;
  }

  /** 尾向开口圆柱 */
  private makeCylinder(xFrom: number, radius: number, xTo: number, color: number, opacity: number): THREE.Object3D {
    const NP = 60;
    const verts: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k < 2; k++) {
      const x = k === 0 ? xFrom : xTo;
      for (let j = 0; j < NP; j++) {
        const phi = (j / NP) * Math.PI * 2;
        verts.push(x, radius * Math.cos(phi), radius * Math.sin(phi));
      }
    }
    for (let j = 0; j < NP; j++) {
      const a = j;
      const b = (j + 1) % NP;
      const c = NP + j;
      const d = NP + ((j + 1) % NP);
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    return m;
  }

  /** 偶极磁场线（r = L·cos²λ），裁剪到磁层顶内 */
  private dipoleLine(L: number, phi: number, fmp: (t: number) => number, rCap: number): THREE.Object3D | null {
    const pts: number[] = [];
    let run: number[] = [];
    const push = () => {
      if (run.length >= 6) pts.push(...run);
      run = [];
    };
    for (let k = 0; k <= 60; k++) {
      const lam = -Math.PI / 2 + (k / 60) * Math.PI;
      const cl = Math.cos(lam);
      const r = L * cl * cl;
      const x = r * cl;
      const rho = r * Math.sin(lam);
      const m = [x, rho * Math.cos(phi), rho * Math.sin(phi)] as [number, number, number];
      // 在磁层顶内则保留
      const rr = Math.hypot(x, rho);
      const theta = Math.atan2(Math.abs(rho), x);
      const inside = rr < Math.min(fmp(Math.min(theta, THETA_LIM)), rCap) || x < -1;
      if (inside) {
        run.push(m[0], m[1], m[2]);
      } else {
        push();
      }
    }
    push();
    if (!pts.length) return null;
    return this.makeLines(pts, COLOR_FIELD, 0.5);
  }

  /** 极区到磁尾的开放磁场线（示意拉伸） */
  private tailLine(phi: number, rCap: number): THREE.Object3D {
    const verts: number[] = [];
    for (const side of [1, -1]) {
      let prev: [number, number, number] | null = null;
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        // 从极区(r≈1.5)出发，向尾向拉长并向外张开
        const rho = 1.4 + t * (rCap * 0.75 - 1.4);
        const x = 0.6 - t * (TAIL_LEN * 0.8);
        const p: [number, number, number] = [x, side * rho * Math.cos(phi), side * rho * Math.sin(phi)];
        if (prev) verts.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
        prev = p;
      }
    }
    return this.makeLines(verts, COLOR_FIELD, 0.32);
  }

  /** 来流/行星际磁场线：挠过弓激波面（ρ = max(b, 激波截面半径)） */
  private streamLine(bImp: number, fbs: (t: number) => number, rCap: number, color: number, opacity: number, latOffset = 0): THREE.Object3D {
    const verts: number[] = [];
    let prev: [number, number, number] | null = null;
    const NC = 70;
    for (let k = 0; k <= NC; k++) {
      const t = k / NC;
      const x = 20 - t * (TAIL_LEN * 1.05); // 从上游 20 R_E 流向下游
      const rhoShock = shockSectionRadius(x, fbs, rCap);
      const rho = Math.max(bImp, rhoShock);
      const p: [number, number, number] = [x, latOffset, rho];
      if (prev) verts.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
      prev = p;
    }
    return this.makeLines(verts, color, opacity);
  }

  private makeLines(vertices: number[], color: number, opacity: number): THREE.LineSegments {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const obj = new THREE.LineSegments(geo, mat);
    obj.frustumCulled = false;
    return obj;
  }
}

/** 截断后的边界半径（θ 处） */
function rLim(f: (t: number) => number, rCap: number, theta: number): number {
  return Math.min(f(theta), rCap);
}

/** 弓激波在轴向位置 x 处的横截面半径（由模型数值反查） */
function shockSectionRadius(x: number, fbs: (t: number) => number, rCap: number): number {
  let best = 0;
  for (let i = 0; i <= 60; i++) {
    const theta = (i / 60) * THETA_LIM;
    const r = Math.min(fbs(theta), rCap);
    const fx = r * Math.cos(theta);
    if (Math.abs(fx - x) < 2.5) {
      const rho = r * Math.sin(theta);
      if (rho > best) best = rho;
    }
  }
  return best;
}

const LOCAL_X = new THREE.Vector3(1, 0, 0);
const _dir = new THREE.Vector3();
