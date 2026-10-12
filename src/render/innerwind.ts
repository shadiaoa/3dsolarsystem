/**
 * 日–火区间太阳风**精细结构（实测）**：Parker Solar Probe / Solar Orbiter / Helios 1,2 的
 * 就地测量轨迹，按实测风速着色。仅覆盖 0.05–1.7 AU —— 该区间外从未被就地测量，
 * 任何绘制都只能是近似，故本层严格不外推（与「示意层」的分工正在于此）。
 *
 * 数据：public/data/innerwind.json（scripts/fetch-innerheliosphere.mjs 自 CDAWeb 拉取），
 *       **按需加载**：只有开启本模式时才请求该文件。
 * 坐标：数据本身即 HGI（日心惯性系，经与 PSP_HELIO1HR_POSITION 的 HGI_LON 比对确认），
 *       转黄道只需绕 x 轴旋转太阳黄赤交角 7.25°（HGI 的 x 轴按定义为太阳赤道升交点）。
 *       符号差异仅导致整团数据约 7° 的方位偏转，不影响结构与尺度。
 */
import * as THREE from "three";
import { toDisplay } from "./scale";

const AU_KM = 149597870.7;
/** 太阳自转轴相对黄道的倾角 */
const SUN_OBLIQUITY = 7.25 * (Math.PI / 180);
/** 时间断档超过此值则断开折线（否则会把相隔很远的两次测量直连） */
const GAP_DAYS = 1.0;

/** 风速色标（km/s）：慢风偏蓝 → 快风偏红 */
const SPEED_STOPS: { v: number; c: [number, number, number] }[] = [
  { v: 300, c: [0.16, 0.32, 0.88] },
  { v: 400, c: [0.20, 0.74, 0.92] },
  { v: 500, c: [0.32, 0.86, 0.42] },
  { v: 600, c: [0.96, 0.86, 0.26] },
  { v: 760, c: [0.96, 0.32, 0.24] },
];

function speedColor(v: number): [number, number, number] {
  const k = Math.min(SPEED_STOPS[SPEED_STOPS.length - 1].v, Math.max(SPEED_STOPS[0].v, v));
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const a = SPEED_STOPS[i - 1];
    const b = SPEED_STOPS[i];
    if (k <= b.v) {
      const f = (k - a.v) / (b.v - a.v);
      return [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f, a.c[2] + (b.c[2] - a.c[2]) * f];
    }
  }
  return SPEED_STOPS[SPEED_STOPS.length - 1].c;
}

interface InnerData {
  fields: string[];
  sampleStepHours: number;
  count: number;
  series: Record<string, number[][]>;
}

export class InnerWindLayer {
  readonly group: THREE.Group;
  private data: InnerData | null = null;
  private loading = false;
  private wantVisible = false;
  private builtKey = "";
  private frames: THREE.Object3D[] = [];

  constructor(world: THREE.Object3D) {
    this.group = new THREE.Group();
    this.group.name = "innerwind";
    this.group.visible = false;
    world.add(this.group);
  }

  /** 本层按需加载：首次开启时才请求数据文件 */
  setVisible(v: boolean) {
    this.wantVisible = v;
    if (v && !this.data && !this.loading) this.load();
    this.group.visible = v && !!this.data;
  }

  get ready() {
    return !!this.data;
  }

  private load() {
    this.loading = true;
    fetch(import.meta.env.BASE_URL + "data/innerwind.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<InnerData>;
      })
      .then((d) => {
        if (!d?.series) throw new Error("数据结构异常");
        this.data = d;
        this.builtKey = "";
        this.setVisible(this.wantVisible); // 触发构建
      })
      .catch(() => {
        this.loading = false;
        /* 离线/缺文件：本层不可用，界面按钮保持关闭 */
      });
  }

  /**
   * 每帧：几何是历史实测（静态），只需按当前比例模式重建一次并把组放到太阳处。
   * sunDispPos 必须是**显示位置**（本组挂在 kit.world 下，该组在真实比例下带 −原点 偏移）。
   * 数据坐标为日心惯性系，不随太阳自转共转。
   */
  update(sunDispPos: THREE.Vector3, trueMode: boolean) {
    if (!this.data) return;
    const key = trueMode ? "true" : "display";
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(trueMode);
    }
    this.group.position.copy(sunDispPos);
  }

  private build(trueMode: boolean) {
    for (const f of this.frames) {
      this.group.remove(f);
      f.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | undefined;
        mat?.dispose();
      });
    }
    this.frames = [];

    const d = this.data!;
    const idx = Object.fromEntries(d.fields.map((f, k) => [f, k]));
    for (const [key, rows] of Object.entries(d.series)) {
      const pos: number[] = [];
      const col: number[] = [];
      let prev: [number, number, number] | null = null;
      let prevJd = -1e9;
      for (const s of rows) {
        const jd = s[idx.jd];
        const rAU = s[idx.rAU];
        const lat = s[idx.hgiLatDeg] * (Math.PI / 180);
        const lon = s[idx.hgiLonDeg] * (Math.PI / 180);
        const v = s[idx.vKmS];
        // HGI → 黄道（绕升交点轴旋转太阳黄赤交角）
        const xH = rAU * Math.cos(lat) * Math.cos(lon);
        const yH = rAU * Math.cos(lat) * Math.sin(lon);
        const zH = rAU * Math.sin(lat);
        const cosE = Math.cos(SUN_OBLIQUITY);
        const sinE = Math.sin(SUN_OBLIQUITY);
        const xE = xH;
        const yE = yH * cosE - zH * sinE;
        const zE = yH * sinE + zH * cosE;
        let p: [number, number, number];
        if (trueMode) {
          p = [xE * AU_KM, zE * AU_KM, -yE * AU_KM]; // Three = (x_ecl, z_ecl, −y_ecl)
        } else {
          toDisplay(xE, zE, -yE, _v);
          p = [_v.x, _v.y, _v.z];
        }
        const c = speedColor(v);
        if (prev && jd - prevJd <= GAP_DAYS) {
          pos.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
          col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
        }
        prev = p;
        prevJd = jd;
      }
      if (!pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
      const line = new THREE.LineSegments(geo, mat);
      line.frustumCulled = false;
      line.name = `innerwind-${key}`;
      this.group.add(line);
      this.frames.push(line);
    }
  }

  /** 风速色标图例（供界面提示用） */
  static legendText(): string {
    return "色标：蓝 300 → 青 400 → 绿 500 → 黄 600 → 红 760+ km/s";
  }
}

const _v = new THREE.Vector3();
