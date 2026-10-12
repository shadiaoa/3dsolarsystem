/**
 * 太阳风结构层（**结构可视化**，非实景 —— 太阳风肉眼不可见，此处只画经过实测校准的物理结构）。
 *
 * 元素与依据：
 *  1) 帕克螺旋磁场线：帕克 1958 解析解 φ(r) = φ₀ + (Ω/v)(r − R_ss)，纬度沿力线不变。
 *     风速 v 取所选日期所在卡林顿周的 OMNI 实测均值 ⇒ 1 AU 处螺距角 ψ = atan(Ωr/v) 落在实测 40~47°。
 *  2) 径向流线：等离子体径向流出（与螺旋线的夹角即螺旋角，用于直观呈现该角度）。流动不随太阳自转。
 *  3) 日球电流片：磁偶极倾角 α 取 WSO 经典模型（L_av），表现为磁赤道面内的倾斜薄盘 + 外缘波浪环。
 *  4) 终止激波 / 日球层顶：半径取旅行者实测（终止激波 84~94 AU、日球层顶 119~121.6 AU）的球壳，
 *     **形状为理想化**（真实形状尚无定论，见评估结论）。
 *  5) 共转：螺旋与电流片随太阳以 25.38 天（NSSDCA 太阳恒星自转）共转；日球层边界不共转。
 *
 * 数据：public/data/solarwind.json（scripts/fetch-solarwind.mjs 自 CDAWeb OMNI2 + WSO 拉取）。
 * 说明：绝对极性归属随 Hale 定律每 11 年反转，本层只呈现"两种极性的扇形结构"，不声明哪个半球为指向/背离。
 */
import * as THREE from "three";
import { toDisplay } from "./scale";

const AU_KM = 149597870.7;
const R_SUN_KM = 696340;
/** 源面半径：标准的 2.5 R☉（电流片与螺旋的起始面） */
const R_SS_AU = (2.5 * R_SUN_KM) / AU_KM;
/** 外延半径：日球层顶（120 AU） */
const R_OUT_AU = 120;
/** 太阳恒星自转：609.12 h（NSSDCA 太阳情况表）⇒ Ω */
const SUN_SIDEREAL_DAYS = 609.12 / 24;
const OMEGA_SUN = (2 * Math.PI) / (SUN_SIDEREAL_DAYS * 86400); // rad/s

/** 旅行者实测边界（AU）：终止激波 V1=94(2004)/V2=84(2007)，日球层顶 V1=121.6(2012)/V2=119(2018) */
const R_TS_AU = 90;
const R_HP_AU = 120;

const AZIMUTHS_SPIRAL = 32;
const AZIMUTHS_FLOW = 16;
const LATITUDES = [-20, 20];
const SEGMENTS = 120;

const COLOR_FIELD_N = 0x6fb7ff; // 磁赤道以北
const COLOR_FIELD_S = 0xff9a6a; // 赤道以南
const COLOR_FLOW = 0xd8e6ff; // 径向流
const COLOR_SHEET = 0xffc46b; // 电流片
const COLOR_TS = 0x7fe0c0; // 终止激波
const COLOR_HP = 0xc9a0ff; // 日球层顶

const DEG = Math.PI / 180;

interface RotRow {
  startJD: number;
  v: number;
  n: number;
  bMag: number;
  bx: number;
  bz: number;
  f107: number;
  tilt: number;
}

export interface SolarWindSample extends RotRow {
  /** 该周所在的卡林顿周起始儒略日 */
  crStartJD: number;
}

export class SolarWindLayer {
  readonly group: THREE.Group;
  /** 随太阳共转的部分（螺旋 + 电流片） */
  private rotGroup = new THREE.Group();
  /** 不共转的部分（径向流 + 日球层边界） */
  private staticGroup = new THREE.Group();
  private rows: RotRow[] = [];
  private ready = false;
  private builtKey = "";
  private visible = false;

  constructor(world: THREE.Object3D) {
    this.group = new THREE.Group();
    this.group.name = "solarwind";
    this.group.add(this.rotGroup, this.staticGroup);
    this.group.visible = false;
    world.add(this.group);

    fetch(import.meta.env.BASE_URL + "data/solarwind.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ fields: string[]; rotations: number[][] }>;
      })
      .then((d) => {
        const idx = Object.fromEntries(d.fields.map((f, k) => [f, k]));
        this.rows = (d.rotations ?? []).map((r) => ({
          startJD: r[idx.startJD],
          v: r[idx.v],
          n: r[idx.n],
          bMag: r[idx.bMag],
          bx: r[idx.bx],
          bz: r[idx.bz],
          f107: r[idx.f107],
          tilt: r[idx.tilt],
        }));
        this.ready = this.rows.length > 0;
      })
      .catch(() => {
        /* 离线/缺文件：该层不显示 */
      });
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.group.visible = v && this.ready;
  }

  /** 当前日期对应的卡林顿周参数（早于/晚于覆盖范围时钳到端点） */
  get current(): SolarWindSample | null {
    if (!this.ready) return null;
    const jd = this.lastJD;
    let lo = 0;
    let hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.rows[mid].startJD <= jd) lo = mid;
      else hi = mid - 1;
    }
    return { ...this.rows[lo], crStartJD: this.rows[lo].startJD };
  }

  private lastJD = 0;

  /** 由实测风速算出的 1 AU 螺旋角（度）：ψ = atan(Ωr/v) */
  static spiralAngleDeg(vKmS: number): number {
    const tanPsi = (OMEGA_SUN * AU_KM) / Math.max(1, vKmS);
    return (Math.atan(tanPsi) * 180) / Math.PI;
  }

  /**
   * 每帧：按日期取参数（变化时重建几何），放在太阳位置并施加共转角。
   * sunDispPos 必须是**显示位置**（本组挂在 kit.world 下，该组在真实比例下带 −原点 偏移）。
   * sunSpinRad 直接取太阳网格的自转角，保证螺旋图案与渲染出的太阳表面同步共转。
   */
  update(jd: number, sunDispPos: THREE.Vector3, sunSpinRad: number, trueMode: boolean) {
    if (!this.ready || !this.visible) return;
    this.lastJD = jd;
    const s = this.current!;
    const key = `${s.startJD}|${trueMode ? 1 : 0}`;
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(s, trueMode);
      this.updateReadout(s);
    }
    this.group.position.copy(sunDispPos);
    this.rotGroup.rotation.y = sunSpinRad;
  }

  /**
   * 把该卡林顿周的实测驱动参数与由它推出的螺旋角写进开关的悬浮提示：
   * 既能自证（ψ 由实测风速算出，应落在实测 40~47°），也标明本层是结构可视化。
   */
  private updateReadout(s: RotRow) {
    const el = document.getElementById("chk-solarwind");
    if (!el) return;
    const psi = SolarWindLayer.spiralAngleDeg(s.v).toFixed(1);
    const tiltTxt = s.tilt >= 0 ? `${s.tilt.toFixed(1)}°` : "暂无（超出 WSO 覆盖 1976–2025），按 10° 示意";
    // 值为 0 表示该周缺乏有效实测（上游填充值已剔除），显示为「—」而非真实零值
    const f = (v: number, unit: string) => (v > 0 ? `${v.toFixed(unit === "nT" ? 1 : 2)} ${unit}` : "—");
    el.title =
      `结构可视化（太阳风肉眼不可见）\n` +
      `帕克螺旋磁场线 · 径向流线 · 日球电流片 · 终止激波/日球层顶（理想化球壳）\n` +
      `── 当前卡林顿周（OMNI2 实测均值 / WSO 倾角）──\n` +
      `风速 ${s.v.toFixed(0)} km/s → 1 AU 螺旋角 ${psi}°\n` +
      `质子密度 ${f(s.n, "/cc")}　IMF |B| ${f(s.bMag, "nT")}　Bx ${f(s.bx, "nT")} / Bz ${f(s.bz, "nT")}\n` +
      `F10.7 ${s.f107 > 0 ? s.f107.toFixed(1) : "—"} sfu　电流片倾角 ${tiltTxt}`;
  }

  /** 把日心球坐标（经纬度）写入顶点数组 */
  private push(out: number[], rAU: number, latRad: number, lonRad: number, trueMode: boolean) {
    const cl = Math.cos(latRad);
    const xEcl = rAU * cl * Math.cos(lonRad);
    const yEcl = rAU * cl * Math.sin(lonRad);
    const zEcl = rAU * Math.sin(latRad);
    // 本项目约定：Three = (x_ecl, z_ecl, −y_ecl)
    if (trueMode) {
      out.push(xEcl * AU_KM, zEcl * AU_KM, -yEcl * AU_KM);
    } else {
      toDisplay(xEcl, zEcl, -yEcl, _v);
      out.push(_v.x, _v.y, _v.z);
    }
  }

  private radiusInMode(rAU: number, trueMode: boolean): number {
    if (trueMode) return rAU * AU_KM;
    toDisplay(rAU, 0, 0, _v);
    return _v.x;
  }

  private build(s: RotRow, trueMode: boolean) {
    this.clearGroup(this.rotGroup);
    this.clearGroup(this.staticGroup);

    const tiltDeg = s.tilt >= 0 ? Math.min(70, s.tilt) : 10; // >70° 官方标注为下限，此处钳到 70
    const alpha = tiltDeg * DEG;
    // 偶极轴：太阳自转轴（+Y）向 +Z 倾斜 α；电流片为其法向平面
    const axis = new THREE.Vector3(0, Math.cos(alpha), Math.sin(alpha)).normalize();

    /* ── 1) 帕克螺旋磁场线：按磁赤道上下半球着色 ── */
    const nNorth: number[] = [];
    const nSouth: number[] = [];
    for (let a = 0; a < AZIMUTHS_SPIRAL; a++) {
      const lon0 = (a / AZIMUTHS_SPIRAL) * Math.PI * 2;
      for (const latDeg of LATITUDES) {
        const lat0 = latDeg * DEG;
        // 磁纬度符号决定落在电流片哪一侧
        const d0 = new THREE.Vector3(
          Math.cos(lat0) * Math.cos(lon0),
          Math.sin(lat0),
          -Math.cos(lat0) * Math.sin(lon0),
        );
        const target = d0.dot(axis) >= 0 ? nNorth : nSouth;
        let prev: [number, number, number] | null = null;
        for (let k = 0; k <= SEGMENTS; k++) {
          const f = k / SEGMENTS;
          // 对数分布：近日侧加密
          const rAU = R_SS_AU * Math.pow(R_OUT_AU / R_SS_AU, f);
          // 帕克解：φ(r) = φ0 − (Ω/v)(r − R_ss)。方位角随半径**减小**（拖尾螺旋）——
          // 等离子体离日时把当时足点方位"冻结"下来，越靠外的等离子体出发越早、足点方位越小。
          // 即 B_φ/B_r = −Ωr·sinθ/v（负号）：螺距角取绝对值，但绕向必须为拖尾。
          const lon = lon0 - (OMEGA_SUN / Math.max(1, s.v)) * (rAU - R_SS_AU) * AU_KM;
          const tmp: number[] = [];
          this.push(tmp, rAU, lat0, lon, trueMode);
          const p: [number, number, number] = [tmp[0], tmp[1], tmp[2]];
          if (prev) {
            target.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
          }
          prev = p;
        }
      }
    }
    this.rotGroup.add(this.makeLines(nNorth, COLOR_FIELD_N));
    this.rotGroup.add(this.makeLines(nSouth, COLOR_FIELD_S));

    /* ── 2) 径向流线（不共转）── */
    const flow: number[] = [];
    for (let a = 0; a < AZIMUTHS_FLOW; a++) {
      const lon0 = (a / AZIMUTHS_FLOW) * Math.PI * 2;
      for (const latDeg of LATITUDES) {
        const lat0 = latDeg * DEG;
        let prev: [number, number, number] | null = null;
        for (let k = 0; k <= 40; k++) {
          const f = k / 40;
          const rAU = R_SS_AU * Math.pow(R_OUT_AU / R_SS_AU, f);
          const tmp: number[] = [];
          this.push(tmp, rAU, lat0, lon0, trueMode);
          const p: [number, number, number] = [tmp[0], tmp[1], tmp[2]];
          if (prev) flow.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
          prev = p;
        }
      }
    }
    this.staticGroup.add(this.makeLines(flow, COLOR_FLOW, 0.35));

    /* ── 3) 电流片：磁赤道面内的薄盘 + 外缘波浪环（共转）── */
    const rIn = this.radiusInMode(R_SS_AU, trueMode);
    const rOut = this.radiusInMode(R_OUT_AU, trueMode);
    const ring = new THREE.RingGeometry(rIn, rOut, 192, 1);
    const ringMat = new THREE.MeshBasicMaterial({
      color: COLOR_SHEET, side: THREE.DoubleSide, transparent: true, opacity: 0.09, depthWrite: false,
    });
    const sheet = new THREE.Mesh(ring, ringMat);
    sheet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    this.rotGroup.add(sheet);

    // 外缘波浪环（LineLoop）：与圆盘同一平面约定（XY 面 → 旋转到磁赤道面）
    const qSheet = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const rim: number[] = [];
    for (let a = 0; a <= 240; a++) {
      const lon = (a / 240) * Math.PI * 2;
      const p = new THREE.Vector3(Math.cos(lon), Math.sin(lon), 0);
      p.applyQuaternion(qSheet);
      rim.push(p.x * rOut, p.y * rOut, p.z * rOut);
    }
    this.rotGroup.add(this.makeLineLoop(rim, COLOR_SHEET, 0.5));

    /* ── 4) 终止激波 / 日球层顶：理想化球壳（不共转）── */
    this.staticGroup.add(this.makeShell(R_TS_AU, trueMode, COLOR_TS, 0.05));
    this.staticGroup.add(this.makeShell(R_HP_AU, trueMode, COLOR_HP, 0.05));
  }

  /** 重建前释放旧几何与材质，避免反复换日期时泄漏 */
  private clearGroup(g: THREE.Group) {
    for (const c of g.children) {
      const mesh = c as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
    g.clear();
  }

  private makeLines(vertices: number[], color: number, opacity = 0.55): THREE.Object3D {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const obj = new THREE.LineSegments(geo, mat);
    obj.frustumCulled = false;
    return obj;
  }

  private makeLineLoop(vertices: number[], color: number, opacity: number): THREE.Object3D {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const obj = new THREE.LineLoop(geo, mat);
    obj.frustumCulled = false;
    return obj;
  }

  private makeShell(rAU: number, trueMode: boolean, color: number, opacity: number): THREE.Object3D {
    const r = this.radiusInMode(rAU, trueMode);
    const geo = new THREE.SphereGeometry(r, 48, 32);
    const mat = new THREE.MeshBasicMaterial({
      color, side: THREE.BackSide, transparent: true, opacity, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    return m;
  }
}

const _v = new THREE.Vector3();
