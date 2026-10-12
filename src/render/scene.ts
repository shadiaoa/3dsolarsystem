/**
 * 场景骨架：渲染器（LogarithmicDepthBuffer 对抗深度跨度）、相机、
 * OrbitControls（阻尼/缩放/平移）、光照、程序化星空背景。
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createStarfield } from "./starfield";

export interface SceneKit {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** 世界组：每帧 position = −浮动原点（真实比例模式对抗 float32 精度） */
  world: THREE.Group;
  sunLight: THREE.PointLight;
  /** 星空组：真实星表（Hipparcos）异步替换程序化占位 */
  starfield: THREE.Group;
}

export function createScene(canvas: HTMLCanvasElement): SceneKit {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000005);
  const starfield = createStarfield(6000);
  scene.add(starfield);

  const world = new THREE.Group();
  scene.add(world);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.002, 9000);
  camera.position.set(-38, 52, 92);
  scene.add(camera); // 星空在真实比例下挂到相机上，相机必须入场景图才会渲染其子节点

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.02;
  controls.maxDistance = 4000;
  controls.zoomSpeed = 1.2;
  controls.rotateSpeed = 0.6;
  // 右键平移 / 中键缩放（默认），触屏双指缩放平移
  controls.screenSpacePanning = true;

  // 太阳光：无衰减点光（观赏模式下行星亮度与距离无关，避免外行星全黑）；
  // 挂在 world 组内，每帧由 main 同步到太阳位置（真实比例下太阳不在根原点）
  const sunLight = new THREE.PointLight(0xfff2dd, 2.8, 0, 0);
  world.add(sunLight);
  scene.add(new THREE.AmbientLight(0x3a4466, 0.45));

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);

  return { renderer, scene, camera, controls, world, sunLight, starfield };
}
