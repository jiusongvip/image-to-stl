// 饼干压模 = 一圈等厚的墙带，没有底板。墙带是环形封闭曲面，
// 相邻线段在角点上共用同一个内偏移顶点，切片器才看不到开口。
import { type Triangle } from "./stl-utils";

export interface CutterParams {
  wallHeight: number;
  wallThickness: number;
}

type Pt2 = [number, number];

const EPS = 1e-7;

function dedupeLoop(points: Pt2[]): Pt2[] {
  const out: Pt2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) continue;
    out.push(p);
  }
  while (out.length > 3) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < EPS && Math.abs(f[1] - l[1]) < EPS) out.pop();
    else break;
  }
  return out;
}

/** 有向面积（XZ 平面）。正为 CCW。 */
function signedArea(pts: Pt2[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    sum += x0 * z1 - x1 * z0;
  }
  return sum / 2;
}

/**
 * 沿角平分线向内偏移 d。逐段各自偏移会让相邻线段在角点错开，
 * 环上因此留下缝隙；共用的角点顶点才能把墙带闭合成流形。
 * 尖角处偏移距离会发散，用 cosHalf 下限夹住。
 */
function offsetInward(pts: Pt2[], d: number): Pt2[] {
  const n = pts.length;
  const normals: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % n];
    const len = Math.hypot(x1 - x0, z1 - z0) || 1;
    normals.push([(z1 - z0) / len, -(x1 - x0) / len]);
  }
  return pts.map(([x, z], i) => {
    const prev = normals[(i - 1 + n) % n];
    const next = normals[i];
    let bx = prev[0] + next[0];
    let bz = prev[1] + next[1];
    const blen = Math.hypot(bx, bz);
    if (blen < EPS) return [x - next[0] * d, z - next[1] * d];
    bx /= blen;
    bz /= blen;
    const cosHalf = Math.max(0.25, bx * next[0] + bz * next[1]);
    const off = d / cosHalf;
    return [x - bx * off, z - bz * off];
  });
}

export function buildCookieCutterMesh(contour: Pt2[], params: CutterParams): Triangle[] {
  const { wallHeight, wallThickness } = params;
  const triangles: Triangle[] = [];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of contour) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const span = Math.max(maxX - minX, maxZ - minZ);
  if (!(span > 0)) return triangles;

  const cx = (minX + maxX) / 2;
  const cy = (minZ + maxZ) / 2;
  const scale = 80 / span; // 与 UI 一致：最长边铺满 80mm

  let outer = dedupeLoop(contour.map(([x, z]): Pt2 => [(x - cx) * scale, (z - cy) * scale]));
  if (outer.length < 3) return triangles;
  // 压模的内外侧全靠 CCW 约定判定，描图结果方向不定，先统一。
  if (signedArea(outer) < 0) outer = outer.slice().reverse();

  const inner = offsetInward(outer, wallThickness);
  const n = outer.length;
  const top = wallHeight;

  const oBot = (i: number): [number, number, number] => [outer[i][0], 0, outer[i][1]];
  const oTop = (i: number): [number, number, number] => [outer[i][0], top, outer[i][1]];
  const iBot = (i: number): [number, number, number] => [inner[i][0], 0, inner[i][1]];
  const iTop = (i: number): [number, number, number] => [inner[i][0], top, inner[i][1]];

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x0, z0] = outer[i];
    const [x1, z1] = outer[j];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < EPS) continue;
    const nx = (z1 - z0) / len;
    const nz = -(x1 - x0) / len;
    const outward: [number, number, number] = [nx, 0, nz];

    // 外壁，法线朝外
    triangles.push(
      { normal: outward, vertices: [oBot(i), oTop(i), oTop(j)] },
      { normal: outward, vertices: [oBot(i), oTop(j), oBot(j)] },
    );
    // 内壁，从孔洞一侧看才是正面
    const inward: [number, number, number] = [-nx, 0, -nz];
    triangles.push(
      { normal: inward, vertices: [iBot(i), iBot(j), iTop(j)] },
      { normal: inward, vertices: [iBot(i), iTop(j), iTop(i)] },
    );
    // 顶面环带
    triangles.push(
      { normal: [0, 1, 0], vertices: [oTop(j), oTop(i), iTop(i)] },
      { normal: [0, 1, 0], vertices: [oTop(j), iTop(i), iTop(j)] },
    );
    // 底面环带（切削刃所在的一圈）
    triangles.push(
      { normal: [0, -1, 0], vertices: [oBot(j), iBot(j), iBot(i)] },
      { normal: [0, -1, 0], vertices: [oBot(j), iBot(i), oBot(i)] },
    );
  }

  return triangles;
}
