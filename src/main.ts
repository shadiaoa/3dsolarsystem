/**
 * 主入口：数据流（规格 §2.2）
 *   时间 t → 天体力学解算（纯函数）→ 物理状态（AU/km）→ 显示变换 f → 渲染
 * 一切位置是 t 的纯函数：时间快进/倒放/跳转无状态漂移。
 */
import * as THREE from "three";
import { createScene } from "./render/scene";

window.addEventListener("error", (e) => {
  console.error("[page-error]", e.message, `${e.filename}:${e.lineno}:${e.colno}`);
});
import { buildBodies, applyDisplayPositions, applyTruePositions, setScaleMode, spinAngle, type SimBody, type ScaleMode } from "./render/bodies";
import { OrbitLines } from "./render/orbits";
import { AsteroidBelt } from "./render/belt";
import { KuiperBelt } from "./render/kuiper";
import { SolarWindLayer } from "./render/solarwind";
import { InnerWindLayer } from "./render/innerwind";
import { MagnetosphereLayer } from "./render/magnetosphere";
import { KM_PER_AU } from "./render/scale";
import { applyShapes, updateShapeLod } from "./render/shapes";
import { applyRealTextures } from "./render/textures";
import { SurfaceObserver } from "./render/surface";
import { Labels } from "./render/labels";
import { setupUI, type SimState } from "./ui/controls";
import { InfoCard } from "./ui/infocard";
import { PLANETS } from "./data/planets";
import { MOONS } from "./data/moons";
import { SMALL_BODIES } from "./data/sbdb";
import { planetHeliocentric, moonRelative } from "./core/elements";
import { grPerihelionDegPerCy } from "./core/relativity";
import { dateToJD, daysSinceJ2000 } from "./core/time";

const canvas = document.getElementById("scene-canvas") as HTMLCanvasElement;
const kit = createScene(canvas);
const reg = buildBodies(kit.world);
applyRealTextures(reg);
applyShapes(reg);
const orbits = new OrbitLines(kit.world, reg);
const belt = new AsteroidBelt(kit.world);
/** 柯伊伯带真实天体（JPL SBDB，异步加载） */
const kuiper = new KuiperBelt(kit.world);
/** 太阳风结构层（OMNI2 + WSO，异步加载；结构可视化） */
const solarwind = new SolarWindLayer(kit.world);
/** 日–火区间太阳风精细结构（PSP/SolarOrbiter/Helios 就地实测，按需加载） */
const innerwind = new InnerWindLayer(kit.world);
/** 太阳风–地球磁层相互作用示意图（尺寸由实测太阳风驱动，选中地球时显示） */
const magnetosphere = new MagnetosphereLayer(kit.world);

const state: SimState = {
  jd: dateToJD(new Date()),
  rate: 1, // 由滑杆初始化覆盖
  paused: false,
  direction: 1,
  followId: null,
  selectedId: null,
  showOrbits: true,
  showLabels: true,
  showMoons: true,
  trueScale: false,
  grEnabled: true,
  showBelt: true,
  showKuiper: true,
  showSolarWind: true,
  showInnerWind: false,
  showMagnetosphere: true,
  solarOnly: false,
  orbitOff: new Set<string>(),
};

/* ─────────────────────────── 物理层（纯函数） ─────────────────────────── */

function grRate(a: number, e: number): number {
  return state.grEnabled ? grPerihelionDegPerCy(a, e) : 0;
}

function updatePhysics(jd: number) {
  const dJ2000 = daysSinceJ2000(jd);
  PLANETS.forEach((p) => {
    const b = reg.byId.get(p.id)!;
    const st = planetHeliocentric(p.elements, jd, grRate(p.elements.a, p.elements.e));
    b.helioAU.set(st.x, st.y, st.z);
    b.rAU = st.rAU;
    b.aAU = st.aAU;
    b.e = st.e;
  });
  SMALL_BODIES.forEach((s) => {
    const b = reg.byId.get(s.id)!;
    const st = planetHeliocentric(s.elements, jd, grRate(s.elements.a, s.elements.e));
    b.helioAU.set(st.x, st.y, st.z);
    b.rAU = st.rAU;
    b.aAU = st.aAU;
    b.e = st.e;
  });
  MOONS.forEach((m) => {
    const b = reg.byId.get(m.id)!;
    const rel = moonRelative(m.elements, jd);
    b.relKm.set(rel.x, rel.y, rel.z);
  });
  if (state.trueScale) applyTruePositions(reg);
  else applyDisplayPositions(reg);
  // 自转（显示层旋转，物理无关）
  for (const b of reg.all) b.mesh.rotation.y = spinAngle(b, dJ2000);
}

/* ─────────────────────────── 选中 / 跟随 / 拾取 ─────────────────────────── */

const infoCard = new InfoCard(reg, {
  onSurface: (id) => {
    if (surface.active && surface.bodyId === id) return; // 已在观测中：幂等，避免反复进入造成抖动
    surface.enter(id, daysSinceJ2000(state.jd), state.rate);
  },
});

function selectBody(id: string | null, follow = false) {
  state.selectedId = id;
  if (follow) state.followId = id;
  labels.setSelected(id);
  ui.setSelected(id, state.followId);
  if (id) infoCard.show(id);
  else infoCard.hide();
}

const labels = new Labels(reg, (id) => selectBody(id, true));

const ui = setupUI(state, reg, {
  onSelect: (id) => {
    if (id === null) {
      state.followId = null;
      ui.setSelected(state.selectedId, null);
    } else {
      selectBody(id, true);
    }
  },
  onVisibility: applyVisibility,
  onTrueScale: () => applyScaleMode(),
  onGR: (on) => orbits.setGR(on),
});

const surface = new SurfaceObserver(reg, kit, { setRate: (r) => ui.setRate(r) });

orbits.setGR(state.grEnabled);

function applyVisibility() {
  orbits.setVisible(state.showOrbits, state.showOrbits && state.showMoons);
  for (const b of reg.all) {
    if (b.id !== reg.sun.id) orbits.setBodyOrbit(b.id, !state.orbitOff.has(b.id));
  }
  for (const m of reg.moons) m.pivot.visible = state.showMoons;
  // 三层「深空层」的用户开关（地表观测时的额外隐藏由主循环叠加，见 frame）
  belt.setVisible(state.showBelt);
  kuiper.setVisible(state.showKuiper);
  solarwind.setVisible(state.showSolarWind);
  innerwind.setVisible(state.showInnerWind);
  magnetosphere.setVisible(state.showMagnetosphere);
  kit.starfield.visible = !state.solarOnly;
}
applyVisibility();

// 深链：?follow=<id> 跟随指定天体；?true=1 真实比例（分享视角与自动化测试用）
// 屏幕空间拾取（保底像素半径，不对微小网格做 3D 射线；规格 §4.2）
const _proj = new THREE.Vector3();
function pickAt(sx: number, sy: number): SimBody | null {
  const w = window.innerWidth, h = window.innerHeight;
  const halfFovTan = Math.tan((kit.camera.fov * Math.PI) / 360);
  let best: SimBody | null = null;
  let bestScore = Infinity;
  for (const b of reg.all) {
    if (b.kind === "moon" && !state.showMoons) continue;
    _proj.copy(b.rootPos).project(kit.camera);
    if (_proj.z > 1 || _proj.z < -1) continue;
    const px = (_proj.x * 0.5 + 0.5) * w;
    const py = (-_proj.y * 0.5 + 0.5) * h;
    const dist = _proj.copy(b.rootPos).distanceTo(kit.camera.position);
    const pxRadius = dist > 0 ? (b.dispR / (2 * dist * halfFovTan)) * h : 8;
    const hitR = Math.max(pxRadius, b.kind === "moon" ? 10 : 14); // 保底命中像素
    const dx = sx - px, dy = sy - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= hitR * hitR) {
      const score = d2 / (hitR * hitR) + dist * 1e-6; // 平局时取近者
      if (score < bestScore) { bestScore = score; best = b; }
    }
  }
  return best;
}

let downX = 0, downY = 0, downT = 0;
canvas.addEventListener("pointerdown", (e) => { downX = e.clientX; downY = e.clientY; downT = performance.now(); });
canvas.addEventListener("pointerup", (e) => {
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (moved < 5 && performance.now() - downT < 600) {
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) selectBody(hit.id, false);
  }
});
canvas.addEventListener("dblclick", (e) => {
  if (surface.active) return; // 地表模式内双击不触发轨道视角的取消跟随
  if (!pickAt(e.clientX, e.clientY)) {
    state.followId = null;
    ui.setSelected(state.selectedId, null);
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && surface.active) surface.exit();
});

/* ─────────────────────────── 真实比例：浮动原点 / 模式切换 ─────────────────────────── */

const ORIGIN_ZERO = new THREE.Vector3();
const originTrue = new THREE.Vector3();
let originBodyId = "sun";
const _tmp = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** 取景方向偏向向阳面：相机置于「天体→太阳」一侧，避免默认看到夜面 */
function sunwardDir(b: SimBody, fallback: THREE.Vector3): THREE.Vector3 {
  _tmp.copy(reg.sun.dispPos).sub(b.dispPos);
  if (_tmp.lengthSq() < 1e-12) return fallback;
  return _dir.copy(_tmp).normalize();
}

/** 切换比例模式：同步尺度、轨道线模式、控制器限位、星空挂载，并重定位相机 */
function applyScaleMode() {
  const mode: ScaleMode = state.trueScale ? "true" : "display";
  _dir.copy(kit.camera.position).sub(kit.controls.target);
  if (_dir.lengthSq() < 1e-12) _dir.set(0, 0, 1);
  _dir.normalize();
  setScaleMode(reg, mode);
  orbits.setMode(mode);
  updatePhysics(state.jd); // 先按新模式算一帧位置，重定位用新坐标
  const fb = state.followId ? reg.byId.get(state.followId) : null;
  if (state.trueScale) {
    kit.controls.minDistance = 0.5;
    kit.controls.maxDistance = 2e10;
    if (kit.starfield.parent !== kit.camera) {
      kit.scene.remove(kit.starfield);
      kit.camera.add(kit.starfield);
      kit.starfield.position.set(0, 0, 0);
    }
    originTrue.set(0, 0, 0);
    if (fb) originTrue.copy(fb.dispPos);
    originBodyId = fb ? fb.id : "sun";
    kit.world.position.copy(originTrue).negate();
    for (const b of reg.all) b.rootPos.copy(b.dispPos).add(kit.world.position);
    kit.controls.target.set(0, 0, 0);
    if (fb) sunwardDir(fb, _dir);
    kit.camera.position.copy(_dir).multiplyScalar(fb ? fb.dispR * 6 : 2.2e8);
  } else {
    kit.controls.minDistance = 0.02;
    kit.controls.maxDistance = 4000;
    if (kit.starfield.parent === kit.camera) {
      kit.camera.remove(kit.starfield);
      kit.scene.add(kit.starfield);
      kit.starfield.position.set(0, 0, 0);
    }
    kit.world.position.set(0, 0, 0);
    for (const b of reg.all) b.rootPos.copy(b.dispPos);
    if (fb) kit.controls.target.copy(fb.dispPos);
    else kit.controls.target.set(0, 0, 0);
    kit.camera.position.copy(kit.controls.target).addScaledVector(_dir, fb ? Math.max(fb.dispR * 6, 0.5) : 124);
    kit.camera.near = 0.002;
    kit.camera.far = 9000;
    kit.camera.updateProjectionMatrix();
  }
}

/* ─────────────────────────── 深链（?follow=<id>、?true=1） ─────────────────────────── */

const qs = new URLSearchParams(location.search);
const qsFollow = qs.get("follow");
if (qsFollow && reg.byId.has(qsFollow)) selectBody(qsFollow, true);
if (qs.get("true") === "1") {
  state.trueScale = true;
  (document.getElementById("chk-true") as HTMLInputElement).checked = true;
  applyScaleMode();
}

/* ─────────────────────────── 主循环 ─────────────────────────── */

const _delta = new THREE.Vector3();
let lastInfo = 0;
const clock = new THREE.Clock();

// 单帧时长上限：低于此帧率时才截断。原值 0.1 意味着帧率跌破 10fps 后时间会被按比例拖慢，
// 表现为"画面一有额外负担，流速就变慢"。放宽到 0.25 允许 4fps 仍按真实时间推进；
// 后台切回的大跳变由下面的 visibilitychange 冲掉时钟增量来处理。
const MAX_FRAME_DT = 0.25;
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) clock.getDelta();
});

let rafId = 0;

function frame() {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), MAX_FRAME_DT);
  if (!state.paused) state.jd += state.direction * state.rate * dt;

  updatePhysics(state.jd);

  if (state.trueScale) {
    // 浮动原点：跟随目标每帧贴合；未跟随则仅在「最近天体」变化时迁移原点，
    // 相机/目标同步平移 −Δ，保持取景不变且根空间坐标小（float32 精度）
    const fb = state.followId ? reg.byId.get(state.followId) : null;
    if (fb) {
      // 原点每帧贴合跟随目标 → 目标根空间位置恒为 0，相机无需平移；
      // 仅切换跟随对象时按当前视线方向重新取景
      const jumped = originBodyId !== fb.id;
      originBodyId = fb.id;
      originTrue.copy(fb.dispPos);
      if (jumped && !surface.active) {
        _dir.copy(kit.camera.position).sub(kit.controls.target);
        if (_dir.lengthSq() < 1e-12) _dir.set(0, 0, 1);
        _dir.normalize();
        sunwardDir(fb, _dir);
        kit.controls.target.set(0, 0, 0);
        kit.camera.position.copy(_dir).multiplyScalar(fb.dispR * 6);
      }
    } else {
      let best = Infinity;
      let bestId = originBodyId;
      for (const b of reg.all) {
        _proj.copy(b.dispPos).add(kit.world.position);
        const d2 = _proj.distanceToSquared(kit.camera.position);
        if (d2 < best) { best = d2; bestId = b.id; }
      }
      if (bestId !== originBodyId) {
        originBodyId = bestId;
        _tmp.copy(reg.byId.get(bestId)!.dispPos).sub(originTrue);
        originTrue.copy(reg.byId.get(bestId)!.dispPos);
        kit.camera.position.sub(_tmp);
        kit.controls.target.sub(_tmp);
      }
    }
    kit.world.position.copy(originTrue).negate();
  } else {
    kit.world.position.set(0, 0, 0);
  }
  kit.sunLight.position.copy(reg.sun.dispPos);
  for (const b of reg.all) b.rootPos.copy(b.dispPos).add(kit.world.position);

  // 小行星带/柯伊伯带：地表观测时隐藏 —— 那个距离上它们星等 20+，肉眼不可见，显示出来反而不真实
  const deepVisible = !surface.active;
  belt.setVisible(state.showBelt && deepVisible);
  kuiper.setVisible(state.showKuiper && deepVisible);
  // 太阳风结构同为肉眼不可见之物，观测模式下同样隐藏
  solarwind.setVisible(state.showSolarWind && deepVisible);
  innerwind.setVisible(state.showInnerWind && deepVisible);

  orbits.update(state.jd, state.trueScale ? originTrue : ORIGIN_ZERO);
  belt.update(state.jd, state.trueScale ? originTrue : ORIGIN_ZERO, state.trueScale);
  kuiper.update(state.jd, state.trueScale ? originTrue : ORIGIN_ZERO, state.trueScale);
  // 共转角直接取太阳网格自转角 → 螺旋图案与渲染出的太阳表面同步
  // 注意：这三层都挂在 kit.world 上（真实比例下 world 带 −原点 偏移），
  // 故必须传 dispPos（与天体自身一致的约定）；传 rootPos 会把偏移算两次、整层被推出视野。
  solarwind.update(state.jd, reg.sun.dispPos, spinAngle(reg.sun, daysSinceJ2000(state.jd)), state.trueScale);
  innerwind.update(reg.sun.dispPos, state.trueScale);

  // 地球磁层示意图：由开关独立控制（不依赖选中状态）；尺寸由当前日期实测太阳风驱动
  const earth = reg.byId.get("earth");
  const showMag = state.showMagnetosphere && deepVisible;
  magnetosphere.setVisible(showMag);
  if (showMag && earth) {
    const sw = solarwind.current;
    magnetosphere.update(earth, reg.sun.dispPos, daysSinceJ2000(state.jd), sw
      ? { n: sw.n, v: sw.v, b: sw.bMag, bz: sw.bz }
      : null);
  }

  // 跟随（观赏模式）：相机与目标整体平移，保留用户当前视角；
  // 真实比例模式由浮动原点承担，无需此步
  if (state.followId && !state.trueScale && !surface.active) {
    const b = reg.byId.get(state.followId);
    if (b) {
      _delta.copy(b.rootPos).sub(kit.controls.target);
      kit.controls.target.copy(b.rootPos);
      kit.camera.position.add(_delta);
    }
  }

  // 真实比例：near/far 随目标距离动态收紧（配合 LogarithmicDepthBuffer）
  // 地表观测模式下由 SurfaceObserver 接管（它的观测目标可能远在 1e8 km 外）
  if (state.trueScale && !surface.active) {
    const d = kit.camera.position.distanceTo(kit.controls.target);
    kit.camera.near = Math.min(10, Math.max(1e-4, d * 1e-4));
    // 柯伊伯带开启时必须覆盖到最远天体（半长轴可达上千 AU），否则整层会被远裁剪面裁掉；
    // 太阳风结构层延伸到日球层顶 120 AU 同理。
    const kuiperFar = state.showKuiper ? kuiper.maxAU * 1.6 * KM_PER_AU : 0;
    const swFar = state.showSolarWind ? 120 * 1.3 * KM_PER_AU : 0;
    const innerFar = state.showInnerWind ? 1.7 * 1.3 * KM_PER_AU : 0;
    kit.camera.far = Math.max(2e4, d * 1e3, kuiperFar, swFar, innerFar);
    kit.camera.updateProjectionMatrix();
  }

  if (surface.active) surface.update(daysSinceJ2000(state.jd), dt);
  else kit.controls.update();
  updateShapeLod(reg, kit.camera);
  labels.update(kit.camera, state);
  ui.update();
  const now = performance.now();
  if (now - lastInfo > 100) { infoCard.refresh(); lastInfo = now; }
  kit.renderer.render(kit.scene, kit.camera);
}
frame();

// HMR 时停掉旧循环并清理地表观测残留，避免新旧实例同时渲染导致闪烁/操作无响应
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cancelAnimationFrame(rafId);
    surface.destroy();
  });
}
