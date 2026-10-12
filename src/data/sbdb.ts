/**
 * 矮行星 / 彗星 / 小行星（规格 §5：sbdb 构建期拉取打包）。
 * 根数源：src/data/sbdb-snapshot.json（scripts/fetch-sbdb.mjs 自 JPL sbdb 全精度拉取），
 * 此处把「历元 epoch 的 (a,e,i,Ω,ω,M)」换算为 J2000 平均根数格式（与行星管线共用 PlanetElements）：
 *   n = 360/P；M(J2000) = M(epoch) + n·(JD_J2000 − epoch)；ϖ = Ω+ω；L = M+ϖ；L̇ = n·36525。
 * 二体线性外推对短周期彗星数十年内足够观赏与教学；长期摄动不在本阶段范围。
 */
import type { PlanetElements } from "../core/elements";
import snapshot from "./sbdb-snapshot.json";

export type SmallBodyKind = "dwarf" | "comet" | "asteroid";

export interface SmallBodyDef {
  id: string;
  name: string;
  nameEn: string;
  kind: SmallBodyKind;
  color: number;
  radiusKm: number;
  massKg: number;
  rotationHours: number;
  axialTiltDeg: number;
  fact: string;
  elements: PlanetElements;
}

interface Meta {
  id: string;
  name: string;
  nameEn: string;
  color: number;
  radiusKm: number;
  massKg: number;
  rotationHours: number;
  axialTiltDeg: number;
  fact: string;
}

const META: Record<string, Meta> = {
  ceres: {
    id: "ceres", name: "谷神星", nameEn: "Ceres", color: 0xb8ae9c,
    radiusKm: 469.7, massKg: 9.39e20, rotationHours: 9.074, axialTiltDeg: 4.0,
    fact: "主带最大天体、唯一位于海王星轨道内的矮行星。Occator 撞击坑的亮斑是地下盐水喷发残留的碳酸钠。",
  },
  pluto: {
    id: "pluto", name: "冥王星", nameEn: "Pluto", color: 0xd8c2a0,
    radiusKm: 1188.3, massKg: 1.303e22, rotationHours: -153.29, axialTiltDeg: 122.5,
    fact: "柯伊伯带之王：氮冰冰川、心形 Sputnik 平原与稀薄大气。2015 年新视野号飞掠返回首批近照。",
  },
  haumea: {
    id: "haumea", name: "妊神星", nameEn: "Haumea", color: 0xe6e2d8,
    radiusKm: 780, massKg: 4.01e21, rotationHours: 3.9155, axialTiltDeg: 4.0,
    fact: "自转仅 3.9 小时，被甩成三轴椭球；带有一道环与一整个碰撞族碎片，表面几乎纯水冰。",
  },
  makemake: {
    id: "makemake", name: "鸟神星", nameEn: "Makemake", color: 0xd9b38c,
    radiusKm: 715, massKg: 3.1e21, rotationHours: 22.83, axialTiltDeg: 2.0,
    fact: "经典柯伊伯带天体，表面覆甲烷冰；2011 年掩星观测发现它有一颗小卫星 MK2。",
  },
  eris: {
    id: "eris", name: "阋神星", nameEn: "Eris", color: 0xf0ede6,
    radiusKm: 1163, massKg: 1.66e22, rotationHours: 15.77, axialTiltDeg: 4.0,
    fact: "质量最大的矮行星。2005 年它的发现直接促使 IAU 定义「行星」并把冥王星降级。",
  },
  "1P": {
    id: "halley", name: "哈雷彗星", nameEn: "1P/Halley", color: 0x9ab8a0,
    radiusKm: 5.5, massKg: 2.2e14, rotationHours: -52.8, axialTiltDeg: 0,
    fact: "最著名的周期彗星（76 年）。1986 年乔托号首次拍得彗核；猎户座流星雨源自它的尘埃。",
  },
  "2P": {
    id: "encke", name: "恩克彗星", nameEn: "2P/Encke", color: 0xb8a888,
    radiusKm: 2.4, massKg: 6.8e12, rotationHours: 11.6, axialTiltDeg: 0,
    fact: "已知周期最短的彗星（3.3 年）；喷流的非引力效应正缓慢缩小其轨道，金牛座流星流与它相关。",
  },
  "67P": {
    id: "67p", name: "67P/丘留莫夫–格拉西缅科", nameEn: "67P/Churyumov–Gerasimenko", color: 0xa89880,
    radiusKm: 1.86, massKg: 9.982e12, rotationHours: 12.4, axialTiltDeg: 55.0,
    fact: "罗塞塔号的目标彗星，鸭形双瓣结构；2014 年菲莱着陆器完成人类首次彗星表面着陆。",
  },
  "C/1995 O1": {
    id: "halebopp", name: "海尔-波普彗星", nameEn: "C/1995 O1 Hale-Bopp", color: 0xc8d8e8,
    radiusKm: 30, massKg: 1.3e16, rotationHours: 11.7, axialTiltDeg: 0,
    fact: "1997 年大彗星：肉眼可见 18 个月、周期约 2530 年，是 20 世纪最亮彗星之一。",
  },
  Bennu: {
    id: "bennu", name: "贝努", nameEn: "101955 Bennu", color: 0x8f8578,
    radiusKm: 0.245, massKg: 7.329e10, rotationHours: -4.296, axialTiltDeg: 178.0,
    fact: "陀螺形近地小行星；2023 年 OSIRIS-REx 带回 121 g 样品。形状模型来自 NASA 3D Resources。",
  },
  Itokawa: {
    id: "itokawa", name: "丝川", nameEn: "25143 Itokawa", color: 0x9a8f80,
    radiusKm: 0.16, massKg: 3.51e10, rotationHours: 12.132, axialTiltDeg: 178.0,
    fact: "碎石堆小行星；2005 年隼鸟号首次采样、2010 年返回，开启小行星采样返回时代。",
  },
  Eros: {
    id: "eros", name: "爱神星", nameEn: "433 Eros", color: 0xa8968a,
    radiusKm: 8.42, massKg: 6.687e15, rotationHours: 5.27, axialTiltDeg: 89.0,
    fact: "首颗被发现的近地小行星（1898）；2001 年 NEAR 鞋匠号成为首个环绕并着陆小行星的探测器。",
  },
  // ── 著名海外天体（矮行星候选）────────────────────────────────────────────
  // 轨道根数由 scripts/fetch-sbdb.mjs 从 JPL SBDB 全精度拉取；
  // 自转周期 rot_per 亦取自 SBDB（LCDB 光度测量）；
  // **半径**：SBDB 对这些天体不给直径，故按标准公式 D = 1329·10^(−H/5)/√p 由 SBDB 的绝对星等 H
  //          与假定几何反照率 p 推算（p 取该类天体的公开发表辐射测量估计），
  //          故为估算值而非直接测量（量级与文献辐射测量半径相符，误差约 20%）。
  // **质量**：由该估算半径按假定密度 1000 kg/m³ 推算（仅用于信息卡展示）。
  // **轴倾角**：多数海外天体自转轴尚未测定，取 0 表示未建模。
  Quaoar: {
    id: "quaoar", name: "创神星", nameEn: "50000 Quaoar", color: 0xd9d2c6,
    radiusKm: 693, massKg: 1.394e21, rotationHours: 8.84, axialTiltDeg: 0,
    fact: "经典柯伊伯带大型天体，有卫星 Weywot；2023 年在其洛希极限之外发现环系，挑战了环的成因理论。",
  },
  Orcus: {
    id: "orcus", name: "亡神星", nameEn: "90482 Orcus", color: 0xbdb8b0,
    radiusKm: 520, massKg: 5.888e20, rotationHours: 13.188, axialTiltDeg: 0,
    fact: "与冥王星成 3:2 共振但轨道相位相反，被称为「反冥王星」；有大型卫星 Vanth（直径约 440 km）。",
  },
  Gonggong: {
    id: "gonggong", name: "共工星", nameEn: "225088 Gonggong", color: 0xc08a78,
    radiusKm: 768, massKg: 1.897e21, rotationHours: 22.4, axialTiltDeg: 0,
    fact: "与海王星成 3:10 共振，是太阳系最红的天体之一（表面甲烷冰）；有卫星 Xiangliu，可能存在地下海洋。",
  },
  Sedna: {
    id: "sedna", name: "赛德娜", nameEn: "90377 Sedna", color: 0xc4756a,
    radiusKm: 589, massKg: 8.558e20, rotationHours: 10.273, axialTiltDeg: 0,
    fact: "离散盘天体：近日点 76 AU、远日点约 937 AU，周期约 1.14 万年。轨道与巨行星解耦，是「第九行星」假说的重要线索。",
  },
  Arrokoth: {
    id: "arrokoth", name: "阿罗科斯", nameEn: "486958 Arrokoth", color: 0xa87060,
    radiusKm: 9, massKg: 3.05e15, rotationHours: 15.918, axialTiltDeg: 0,
    fact: "新视野号 2019 年飞掠，是人类迄今造访的最远天体；双瓣「接触双星」，为星子吸积过程留下了原始样本。",
  },
  Varuna: {
    id: "varuna", name: "伐楼拿", nameEn: "20000 Varuna", color: 0x9aa6b8,
    radiusKm: 322, massKg: 1.398e20, rotationHours: 6.3436, axialTiltDeg: 0,
    fact: "经典柯伊伯带大型天体，自转仅约 6.3 小时，被离心力塑造成明显的三轴椭球。",
  },
  Ixion: {
    id: "ixion", name: "伊克西翁", nameEn: "28978 Ixion", color: 0xa8938a,
    radiusKm: 359, massKg: 1.938e20, rotationHours: 12.58, axialTiltDeg: 0,
    fact: "首个被发现的冥族天体（3:2 共振）之一，表面覆盖暗红色的有机托林。",
  },
  Salacia: {
    id: "salacia", name: "萨拉基亚", nameEn: "120347 Salacia", color: 0xb9b2a6,
    radiusKm: 498, massKg: 5.174e20, rotationHours: 6.09, axialTiltDeg: 0,
    fact: "反照率极低（约 0.04），是新视野号之前最暗的海外天体之一；有卫星 Actaea，可能为岩石核与冰幔分层结构。",
  },
  Varda: {
    id: "varda", name: "瓦尔达", nameEn: "174567 Varda", color: 0xc9c4bb,
    radiusKm: 361, massKg: 1.971e20, rotationHours: 5.91, axialTiltDeg: 0,
    fact: "快速自转（约 5.9 小时）的经典柯伊伯带天体，有卫星 Ilmarë。",
  },
  "2018 VG18": {
    id: "farout18", name: "2018 VG18", nameEn: "2018 VG18 (Farout)", color: 0xd8b0a2,
    radiusKm: 342, massKg: 1.675e20, rotationHours: 12, axialTiltDeg: 0,
    fact: "昵称「Farout」，2018 年发现时是已知最遥远的天体（约 124 AU）；自转周期尚未测定。",
  },
};

const JD_J2000 = 2451545.0;

function toElements(b: (typeof snapshot)["bodies"][number]): PlanetElements {
  const { a, e, i, om, w, ma, per } = b.elements;
  const nDegPerDay = 360 / per;
  const mJ2000 = ma + nDegPerDay * (JD_J2000 - b.epoch);
  const peri = om + w;
  return {
    a, aDot: 0,
    e, eDot: 0,
    i, iDot: 0,
    L: mJ2000 + peri, LDot: nDegPerDay * 36525,
    peri, periDot: 0,
    node: om, nodeDot: 0,
  };
}

export const SMALL_BODIES: SmallBodyDef[] = snapshot.bodies.map((b) => {
  const m = META[b.id];
  return {
    ...m,
    kind: b.kind as SmallBodyKind,
    elements: toElements(b),
  };
});
