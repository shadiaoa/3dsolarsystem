/**
 * 地表观测模式（SurfaceObserver）：站在任意天体表面观察另一个天体。
 *
 * 两种模式（面板切换）：
 *   fixed     固定位置：选定目标时把视角「锁定」在该方向上，之后视角随地面一起转、不再追踪目标；
 *                        天空（恒星与其他天体）自然从画面移过 —— 这才是"日升月落"。
 *   tracking  追踪目标：每帧修正站位与视线，观测天体恒居正中。
 *
 * 关键实现约束：
 *  1) 站立天体的网格在观测期间隐藏（不渲染）：视线永远朝外、本体不会入画；
 *     同时省掉整颗球体（含贴图材质）的渲染开销。
 *  2) 锁定视角存为「天体固连坐标系」下的单位向量 aimLocal：随自转变成世界方向，
 *     于是视角相对地面静止、天空相对视角运动。
 *  3) 选目标/进入时把站位搬到「天体中心→目标」连线的子目标点（目标在正上方），
 *     并立即 applyCamera + 强制刷新相机矩阵，保证"点了就跳到位"。
 */
import * as THREE from "three";
import type { BodyRegistry, SimBody } from "./bodies";
import { spinAngle } from "./bodies";
import type { SceneKit } from "./scene";

const EYE_FACTOR = 1.02; // 相机高度 = 半径 × 1.02（略高于地表，避免贴面裁切）
const ZOOM_MIN = 1;
/** 真实比例下内行星角直径仅约 0.02°，30 倍（FOV 1.67°）根本看不见；放开到 5000 倍（FOV 最低 0.01°） */
const ZOOM_MAX = 5000;
/** 变焦滑杆用对数映射：0 → 1×，1000 → ZOOM_MAX */
const ZOOM_SLIDER_MAX = 1000;
const CALM_RATE = 5 / 1440; // 5 分/秒
const SUN_INTENSITY_ORBIT = 2.8;
const AMBIENT_ORBIT = 0.45;
const AMBIENT_SURFACE = 0.06;
export const SURFACE_BUILD = "v7";

const CSS = `
.surface-panel{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:40;display:flex;flex-direction:column;gap:8px;align-items:stretch;background:rgba(10,14,26,.88);border:1px solid rgba(120,160,255,.28);border-radius:12px;padding:10px 14px;color:#dce8ff;font:13px/1.5 system-ui,sans-serif;backdrop-filter:blur(6px);min-width:390px}
.surface-panel.hidden,.sp-list.hidden{display:none}
.sp-status{text-align:center;font-size:14px}
.sp-status b{color:#8fc1ff}
.sp-build{text-align:center;font-size:11px;color:#6f86ad}
.sp-row{display:flex;gap:8px;align-items:center;justify-content:center}
.sp-row button{background:#27406e;border:1px solid #3f6db0;color:#eaf2ff;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.sp-row button:hover{background:#33548c}
.sp-row button.primary{background:#2f6db0;border-color:#5b9be0}
.sp-row button.mode.active{background:#2f6db0;border-color:#7fb4f0;box-shadow:0 0 0 1px rgba(127,180,240,.45) inset}
.sp-row.zoom{gap:10px}
.sp-row.zoom input{flex:1;accent-color:#5b9be0}
.sp-zoomval{min-width:48px;text-align:right;color:#8fc1ff}
.sp-hint{text-align:center;color:#8ea6cf;font-size:12px}
.sp-list{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);max-height:300px;overflow:auto;background:rgba(12,18,34,.97);border:1px solid rgba(120,160,255,.3);border-radius:10px;padding:6px;display:flex;flex-direction:column;gap:2px;min-width:240px}
.sp-list .grp{color:#7f96c0;font-size:11px;padding:4px 8px 2px;letter-spacing:.05em}
.sp-list button{background:transparent;border:0;color:#dce8ff;text-align:left;padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit}
.sp-list button:hover{background:#27406e}
`;

const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _qTilt = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _local = new THREE.Vector3();
const _worldDir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _north = new THREE.Vector3();
const _east = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();
const UP_Y = new THREE.Vector3(0, 1, 0);

export interface SurfaceHooks {
  setRate?: (daysPerSec: number) => void;
}

export type SurfaceMode = "fixed" | "tracking";

export class SurfaceObserver {
  private reg: BodyRegistry;
  private kit: SceneKit;
  private hooks: SurfaceHooks;
  private _active = false;
  private body: SimBody | null = null;
  private targetId: string | null = null;
  private mode: SurfaceMode = "fixed";

  private lat = 0;
  private lon = 0;
  /** 锁定视角（天体固连坐标系下的单位向量），fixed 模式使用 */
  private aimLocal = new THREE.Vector3(0, 1, 0);
  private zoom = 1;
  private zoomTarget = 1;
  private baseFov = 50;
  private savedNear = 0.002;
  private savedFar = 9000;
  private prevRate: number | null = null;

  /** 观测期间被隐藏的网格（站立天体本体），退出时还原原值 */
  private hiddenMesh = new Map<string, boolean>();

  private panel: HTMLDivElement;
  private elStand: HTMLElement;
  private elWatch: HTMLElement;
  private elModeFixed: HTMLButtonElement;
  private elModeTrack: HTMLButtonElement;
  private elHint: HTMLElement;
  private elList: HTMLDivElement;
  private elZoom: HTMLInputElement;
  private elZoomVal: HTMLElement;

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.setZoomTarget(this.zoomTarget * Math.exp(-e.deltaY * 0.0016));
  };

  constructor(reg: BodyRegistry, kit: SceneKit, hooks: SurfaceHooks = {}) {
    this.reg = reg;
    this.kit = kit;
    this.hooks = hooks;

    document.getElementById("surface-panel")?.remove();
    document.getElementById("surface-style")?.remove();

    const style = document.createElement("style");
    style.id = "surface-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "surface-panel";
    panel.className = "surface-panel hidden";
    panel.innerHTML =
      `<div class="sp-status">站在 <b id="sp-stand">—</b> 上 · 观测 <b id="sp-watch">未选择</b></div>` +
      `<div class="sp-row modes"><button id="sp-m-fixed" class="mode active">固定位置</button><button id="sp-m-track" class="mode">追踪目标</button></div>` +
      `<div class="sp-hint" id="sp-hint"></div>` +
      `<div class="sp-row"><button id="sp-pick" class="primary">选择观测目标…</button><button id="sp-exit">离开地表</button></div>` +
      `<div class="sp-row zoom"><span>望远镜</span><input id="sp-zoom" type="range" min="0" max="${ZOOM_SLIDER_MAX}" step="1" value="0"><span id="sp-zoomval" class="sp-zoomval">×1.00</span></div>` +
      `<div class="sp-build">surface ${SURFACE_BUILD}</div>` +
      `<div id="sp-list" class="sp-list hidden"></div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.elStand = panel.querySelector("#sp-stand")!;
    this.elWatch = panel.querySelector("#sp-watch")!;
    this.elModeFixed = panel.querySelector("#sp-m-fixed") as HTMLButtonElement;
    this.elModeTrack = panel.querySelector("#sp-m-track") as HTMLButtonElement;
    this.elHint = panel.querySelector("#sp-hint")!;
    this.elList = panel.querySelector("#sp-list")!;
    this.elZoom = panel.querySelector("#sp-zoom") as HTMLInputElement;
    this.elZoomVal = panel.querySelector("#sp-zoomval")!;

    this.elModeFixed.addEventListener("click", () => this.setMode("fixed"));
    this.elModeTrack.addEventListener("click", () => this.setMode("tracking"));
    panel.querySelector("#sp-pick")!.addEventListener("click", () => this.toggleList());
    panel.querySelector("#sp-exit")!.addEventListener("click", () => this.exit());
    this.elZoom.addEventListener("input", () => this.setZoomTarget(this.zoomFromSlider(Number(this.elZoom.value))));
  }

  get active() {
    return this._active;
  }
  get bodyId() {
    return this.body?.id ?? null;
  }
  get target() {
    return this.targetId;
  }
  get viewMode() {
    return this.mode;
  }

  private lastDJ2000 = 0;

  enter(id: string, dJ2000 = 0, currentRate?: number) {
    const b = this.reg.byId.get(id);
    if (!b) return;
    if (this._active && this.body === b) return;

    if (this._active) this.teardown(false);
    else if (currentRate !== undefined) this.prevRate = currentRate;

    this.body = b;
    this._active = true;
    this.targetId = null;
    this.mode = "fixed";
    this.zoom = 1;
    this.zoomTarget = 1;
    this.baseFov = this.kit.camera.fov;
    this.lastDJ2000 = dJ2000;

    this.hooks.setRate?.(CALM_RATE);

    // 隐藏站立天体本体：视线永远朝外、本体不会入画；也省掉整颗球体的渲染开销
    if (!this.hiddenMesh.has(b.id)) this.hiddenMesh.set(b.id, b.mesh.visible);
    b.mesh.visible = false;

    this.kit.sunLight.intensity = this.sunIntensityFor(b);
    this.setAmbient(AMBIENT_SURFACE);

    this.kit.controls.enabled = false;
    this.kit.renderer.domElement.addEventListener("wheel", this.onWheel, { passive: false });

    // 进入即站到日下点、朝外看太阳
    this.snapToPoint(this.reg.sun.rootPos);
    this.freezeAim(this.reg.sun.rootPos);
    // 相机 near/far 由本模式接管（真实比例下主循环那套按 controls.target 收紧会把
    // 远达 1e8 km 的观测目标裁掉，这正是"真实比例下看不见目标"的原因）
    this.savedNear = this.kit.camera.near;
    this.savedFar = this.kit.camera.far;
    this.applyFov();
    this.elZoom.value = "0";
    this.elZoomVal.textContent = "×1.00";
    this.elList.classList.add("hidden");
    this.panel.classList.remove("hidden");
    this.syncModeButtons();
    this.refreshStatus();
  }

  private setMode(m: SurfaceMode) {
    if (this.mode === m) return;
    this.mode = m;
    if (m === "tracking") {
      const t = this.targetId ? this.reg.byId.get(this.targetId) : null;
      if (t) this.snapToPoint(t.rootPos);
    }
    this.syncModeButtons();
    this.refreshStatus();
  }

  private syncModeButtons() {
    this.elModeFixed.classList.toggle("active", this.mode === "fixed");
    this.elModeTrack.classList.toggle("active", this.mode === "tracking");
    this.elHint.textContent =
      this.mode === "tracking"
        ? "追踪目标：站位与视线每帧修正，观测天体始终居中 · 滚轮变焦"
        : "固定位置：视角锁定在选定方向（随地面一起转），天空自然移过画面 · 滚轮变焦";
  }

  /** 选定观测目标：站位搬到正对目标的子目标点、锁定视角，并立即生效 */
  setTarget(id: string | null) {
    this.targetId = id && id !== this.bodyId ? id : null;
    const t = this.targetId ? this.reg.byId.get(this.targetId) : null;
    const ref = t ? t.rootPos : this.reg.sun.rootPos;
    this.snapToPoint(ref);
    this.freezeAim(ref);
    this.applyCamera(this.lastDJ2000);
    this.syncModeButtons();
    this.refreshStatus();
  }

  /** 把站位搬到「天体中心 → 点 p」连线交地表处的子目标点（目标即在正上方） */
  private snapToPoint(p: THREE.Vector3) {
    const b = this.body;
    if (!b) return;
    _to.copy(p).sub(b.rootPos);
    if (_to.lengthSq() < 1e-12) return;
    _to.normalize();
    this.frame(b, this.lastDJ2000);
    _qInv.copy(_q).invert();
    _local.copy(_to).applyQuaternion(_qInv).normalize();
    this.lat = Math.asin(Math.max(-1, Math.min(1, _local.y)));
    this.lon = Math.atan2(_local.z, _local.x);
  }

  /** 把「此刻朝向 p 的方向」记成天体固连坐标系下的锁定视角（fixed 模式用） */
  private freezeAim(p: THREE.Vector3) {
    const b = this.body;
    if (!b) return;
    this.frame(b, this.lastDJ2000);
    this.eyeFor(b);
    _to.copy(p).sub(_eye);
    if (_to.lengthSq() < 1e-12) _to.copy(_worldDir);
    _to.normalize();
    _qInv.copy(_q).invert();
    this.aimLocal.copy(_to).applyQuaternion(_qInv).normalize();
  }

  exit() {
    if (!this._active) return;
    this.teardown(true);
    this._active = false;
    this.body = null;
    this.targetId = null;
    this.mode = "fixed";
  }

  private teardown(restoreRate: boolean) {
    const b = this.body;
    if (b) {
      const wasVisible = this.hiddenMesh.get(b.id);
      if (wasVisible !== undefined) b.mesh.visible = wasVisible;
    }
    this.kit.sunLight.intensity = SUN_INTENSITY_ORBIT;
    this.setAmbient(AMBIENT_ORBIT);
    this.kit.controls.enabled = true;
    this.kit.camera.fov = this.baseFov;
    this.kit.camera.near = this.savedNear;
    this.kit.camera.far = this.savedFar;
    this.kit.camera.updateProjectionMatrix();
    this.kit.renderer.domElement.removeEventListener("wheel", this.onWheel);
    this.panel.classList.add("hidden");
    this.elList.classList.add("hidden");
    if (restoreRate && this.prevRate !== null) {
      this.hooks.setRate?.(this.prevRate);
      this.prevRate = null;
    }
  }

  destroy() {
    if (this._active) this.exit();
    this.panel.remove();
    document.getElementById("surface-style")?.remove();
  }

  private setAmbient(v: number) {
    for (const o of this.kit.scene.children) {
      if ((o as THREE.AmbientLight).isAmbientLight) (o as THREE.AmbientLight).intensity = v;
    }
  }

  private sunIntensityFor(b: SimBody): number {
    const r = Math.max(b.rAU, 0.05);
    return Math.max(0.06, Math.min(6, SUN_INTENSITY_ORBIT / (r * r)));
  }

  /** 滑杆（0..ZOOM_SLIDER_MAX，对数）↔ 倍数 */
  private zoomFromSlider(v: number) {
    return Math.pow(ZOOM_MAX, Math.max(0, Math.min(1, v / ZOOM_SLIDER_MAX)));
  }

  private formatZoom(z: number): string {
    const s = z < 10 ? z.toFixed(2) : z < 100 ? z.toFixed(1) : z.toFixed(0);
    return "×" + s;
  }

  private setZoomTarget(z: number) {
    this.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    this.elZoom.value = String(Math.round((Math.log(this.zoomTarget) / Math.log(ZOOM_MAX)) * ZOOM_SLIDER_MAX));
  }

  private applyFov() {
    this.kit.camera.fov = this.baseFov / this.zoom;
    this.kit.camera.updateProjectionMatrix();
  }

  /** 表面切向系：_worldDir(法线) / _north / _east；并更新 _q = tilt·spin */
  private frame(b: SimBody, dJ2000: number) {
    _eul.set(0, 0, (b.axialTiltDeg * Math.PI) / 180);
    _qTilt.setFromEuler(_eul);
    _eul.set(0, spinAngle(b, dJ2000), 0);
    _qSpin.setFromEuler(_eul);
    _q.copy(_qTilt).multiply(_qSpin);
    const cl = Math.cos(this.lat);
    _local.set(cl * Math.cos(this.lon), Math.sin(this.lat), cl * Math.sin(this.lon));
    _worldDir.copy(_local).applyQuaternion(_q).normalize();
    _axis.copy(UP_Y).applyQuaternion(_qTilt).normalize();
    _north.copy(_axis).addScaledVector(_worldDir, -_axis.dot(_worldDir));
    if (_north.lengthSq() < 1e-8) _north.set(0, 0, 1).addScaledVector(_worldDir, -_worldDir.z);
    _north.normalize();
    _east.crossVectors(_north, _worldDir).normalize();
  }

  private eyeFor(b: SimBody) {
    _eye.copy(b.rootPos).addScaledVector(_worldDir, b.dispR * EYE_FACTOR);
  }

  update(dJ2000: number, dt: number) {
    if (!this._active || !this.body) return;
    this.lastDJ2000 = dJ2000;
    const t = this.targetId ? this.reg.byId.get(this.targetId) : null;

    // 追踪模式：每帧把站位修正到子目标点（目标始终在正上方）
    if (this.mode === "tracking" && t) this.snapToPoint(t.rootPos);

    if (Math.abs(this.zoomTarget - this.zoom) > 1e-4) {
      this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 10);
      this.applyFov();
      this.elZoomVal.textContent = this.formatZoom(this.zoom);
    }

    this.applyCamera(dJ2000);
  }

  /** 放置相机：位置 = 地表点；朝向 = 追踪目标 或 锁定的固定方向 */
  private applyCamera(dJ2000: number) {
    const b = this.body;
    if (!b) return;

    this.frame(b, dJ2000);
    this.eyeFor(b);

    const t = this.targetId ? this.reg.byId.get(this.targetId) : null;
    if (this.mode === "tracking" && t) {
      _fwd.copy(t.rootPos).sub(_eye);
      if (_fwd.lengthSq() < 1e-12) _fwd.copy(this.aimLocal).applyQuaternion(_q);
      _fwd.normalize();
    } else {
      // 锁定方向：固连系向量随自转变成世界方向 ⇒ 视角相对地面静止、天空移过画面
      _fwd.copy(this.aimLocal).applyQuaternion(_q).normalize();
    }

    // up 取「当地垂线（地心方向）在垂直于视线方向的投影」：地平线在屏幕上保持水平；
    // 视线接近天顶时退化，此时改用北向切线。
    _up.copy(_worldDir).addScaledVector(_fwd, -_fwd.dot(_worldDir));
    if (_up.lengthSq() < 1e-8) _up.copy(_north).addScaledVector(_fwd, -_north.dot(_fwd));
    if (_up.lengthSq() < 1e-8) _up.copy(_east).addScaledVector(_fwd, -_east.dot(_fwd));
    _up.normalize();

    const cam = this.kit.camera;
    // near/far 必须覆盖到观测目标：真实比例下目标可达 1e8~1e10 km，
    // 若沿用主循环按 controls.target 收紧的 far，目标会被远裁剪面整颗裁掉。
    const ref = t ? t.rootPos : this.reg.sun.rootPos;
    const dx = ref.x - _eye.x;
    const dy = ref.y - _eye.y;
    const dz = ref.z - _eye.z;
    const distT = Math.sqrt(dx * dx + dy * dy + dz * dz);
    cam.near = Math.max(b.dispR * 1e-3, 1e-6);
    cam.far = Math.max(distT * 4, 20000);
    cam.position.copy(_eye);
    cam.up.copy(_up);
    _to.copy(_eye).add(_fwd);
    cam.lookAt(_to);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  private refreshStatus() {
    const t = this.targetId ? this.reg.byId.get(this.targetId) : null;
    this.elStand.textContent = this.body?.name ?? "—";
    const mode = this.mode === "tracking" ? "追踪" : "固定";
    this.elWatch.textContent = t ? `${t.name}（${mode}）` : "未选择";
  }

  private toggleList() {
    if (!this.elList.classList.contains("hidden")) {
      this.elList.classList.add("hidden");
      return;
    }
    this.buildList();
    this.elList.classList.remove("hidden");
  }

  private buildList() {
    const b = this.body;
    this.elList.innerHTML = "";
    const addGroup = (title: string) => {
      const g = document.createElement("div");
      g.className = "grp";
      g.textContent = title;
      this.elList.appendChild(g);
    };
    const addItem = (body: SimBody) => {
      if (!b || body.id === b.id) return;
      const btn = document.createElement("button");
      btn.textContent = body.name;
      btn.addEventListener("click", () => {
        this.setTarget(body.id);
        this.elList.classList.add("hidden");
      });
      this.elList.appendChild(btn);
    };
    addGroup("恒星");
    addItem(this.reg.sun);
    addGroup("行星");
    for (const p of this.reg.planets) {
      addItem(p);
      for (const m of this.reg.moonsOf.get(p.id) ?? []) addItem(m);
    }
    addGroup("矮行星");
    for (const d of this.reg.dwarfs) addItem(d);
    addGroup("彗星");
    for (const c of this.reg.comets) addItem(c);
    addGroup("小行星");
    for (const a of this.reg.asteroids) addItem(a);
  }
}
