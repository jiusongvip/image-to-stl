import { computeNormal, type Triangle } from "./stl-utils";

// 亮度 → 归一化高度网格，以及高度网格 → 水密封闭实体。
// 两条导出路径（普通浮雕 / 石版灯 / 文字）共用这里的实现，
// 保证导出的都是切片软件可以直接消费的封闭体积，而不是开口壳体。

export interface HeightGridSpec {
  invert: boolean;
  removeBackground: boolean;
  /** 平滑半径，单位是输出网格的格数 */
  smoothRadius: number;
  /** 输出网格长边的最大格数，同时决定面数 */
  maxCells: number;
}

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** 输出网格的行列数：长边受 maxCells 约束，短边按原图长宽比推出 */
export function gridShape(imageW: number, imageH: number, maxCells: number): { cols: number; rows: number } {
  const cols = Math.max(2, Math.min(imageW, maxCells));
  const rows = Math.max(2, Math.min(imageH, Math.round((cols * imageH) / imageW)));
  return { cols, rows };
}

/**
 * 把图像采样成 0..1 的高度网格。按面积平均下采样，
 * 网格长宽比跟随原图，因此后面映射到 mm 时不会变形。
 */
export function sampleHeightGrid(img: ImageData, spec: HeightGridSpec): number[][] {
  const { data, width: iw, height: ih } = img;
  const { cols, rows } = gridShape(iw, ih, spec.maxCells);

  const grid: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor((gy * ih) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * ih) / rows));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * iw) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * iw) / cols));
      let sum = 0;
      let opaque = 0;
      for (let y = y0; y < Math.min(y1, ih); y++) {
        for (let x = x0; x < Math.min(x1, iw); x++) {
          const i = (y * iw + x) * 4;
          const luma = (data[i] * LUMA_R + data[i + 1] * LUMA_G + data[i + 2] * LUMA_B) / 255;
          if (data[i + 3] > 8) {
            sum += luma;
            opaque++;
          }
        }
      }
      grid[gy][gx] = opaque > 0 ? sum / opaque : 0;
    }
  }

  if (spec.removeBackground) {
    // 边缘的浅色区域判为背景：从四条边走一遍，把连通的近白区压平。
    const seen = new Uint8Array(rows * cols);
    const stack: number[] = [];
    const push = (x: number, y: number) => {
      const k = y * cols + x;
      if (!seen[k] && grid[y][x] > 0.9) {
        seen[k] = 1;
        stack.push(k);
      }
    };
    for (let x = 0; x < cols; x++) {
      push(x, 0);
      push(x, rows - 1);
    }
    for (let y = 0; y < rows; y++) {
      push(0, y);
      push(cols - 1, y);
    }
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % cols;
      const y = (k - x) / cols;
      grid[y][x] = 0;
      if (x > 0) push(x - 1, y);
      if (x < cols - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < rows - 1) push(x, y + 1);
    }
  }

  if (spec.invert) {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) grid[y][x] = 1 - grid[y][x];
  }

  return blurGrid(grid, Math.max(0, Math.round(spec.smoothRadius)));
}

function blurGrid(grid: number[][], radius: number): number[][] {
  if (radius === 0) return grid;
  const rows = grid.length;
  const cols = grid[0].length;
  const src = grid.map((row) => [...row]);
  const out = grid.map(() => new Array<number>(cols).fill(0));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          sum += src[ny][nx];
          count++;
        }
      }
      out[y][x] = sum / count;
    }
  }
  return out;
}

export interface SolidSpec {
  /** 顶面各格子的绝对高度，毫米，必须为正 */
  heightsMm: number[][];
  /** 打印尺寸，X 方向毫米；Y 方向按网格长宽比自动推出 */
  widthMm: number;
}

/** 把归一化 0..1 高度网格换算成毫米顶面高度：没有底板，最低处就是 Z=0 */
export function toHeightMm(heights: number[][], reliefMm: number): number[][] {
  return heights.map((row) => row.map((v) => clamp01(v) * reliefMm));
}

/**
 * 生成封闭实体：顶面（高度随网格变化）+ 周圈侧壁 + 平底。
 * 顶面绕序按右手定则朝 +Y，侧壁与底面的共享边与之严格配对，
 * 因此结果没有未配对边，切片器不需要修复。
 *
 * 内部沿用本站一贯的约定：平面铺在 XZ，厚度沿 Y。
 * 导出时由 toSlicerSpace 统一转成切片器使用的 Z 朝上。
 */
export function buildClosedSolid(spec: SolidSpec): Triangle[] {
  const { heightsMm: heights, widthMm } = spec;
  const rows = heights.length;
  const cols = heights[0].length;
  if (rows < 2 || cols < 2) return [];

  // 正方形像素：长宽比由网格本身携带，物理尺寸不会被拉成方形
  const pitch = widthMm / (cols - 1);
  const worldX = (x: number) => (x - (cols - 1) / 2) * pitch;
  const worldZ = (y: number) => (y - (rows - 1) / 2) * pitch;
  const worldY = (x: number, y: number) => Math.max(0.01, heights[y][x]);

  const tris: Triangle[] = [];

  // 顶面
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const a: [number, number, number] = [worldX(x), worldY(x, y), worldZ(y)];
      const b: [number, number, number] = [worldX(x + 1), worldY(x + 1, y), worldZ(y)];
      const c: [number, number, number] = [worldX(x), worldY(x, y + 1), worldZ(y + 1)];
      const d: [number, number, number] = [worldX(x + 1), worldY(x + 1, y + 1), worldZ(y + 1)];
      tris.push({ normal: computeNormal(a, c, d), vertices: [a, c, d] });
      tris.push({ normal: computeNormal(a, d, b), vertices: [a, d, b] });
    }
  }

  // 边界环，顺序使顶面的边界边反向配对
  const ring: [number, number][] = [];
  for (let x = 0; x < cols; x++) ring.push([x, 0]);
  for (let y = 1; y < rows; y++) ring.push([cols - 1, y]);
  for (let x = cols - 2; x >= 0; x--) ring.push([x, rows - 1]);
  for (let y = rows - 2; y >= 1; y--) ring.push([0, y]);

  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % n];
    const at: [number, number, number] = [worldX(ax), worldY(ax, ay), worldZ(ay)];
    const bt: [number, number, number] = [worldX(bx), worldY(bx, by), worldZ(by)];
    const ab: [number, number, number] = [worldX(ax), 0, worldZ(ay)];
    const bb: [number, number, number] = [worldX(bx), 0, worldZ(by)];
    tris.push({ normal: computeNormal(at, bt, bb), vertices: [at, bt, bb] });
    tris.push({ normal: computeNormal(at, bb, ab), vertices: [at, bb, ab] });
    // 底面扇形，绕序朝 -Y
    tris.push({ normal: computeNormal([0, 0, 0], ab, bb), vertices: [[0, 0, 0], ab, bb] });
  }

  return tris;
}

export function solidDimensionsMm(spec: SolidSpec): { widthMm: number; depthMm: number; heightMm: number } {
  const rows = spec.heightsMm.length;
  const cols = spec.heightsMm[0].length;
  const pitch = spec.widthMm / Math.max(1, cols - 1);
  let top = 0;
  for (const row of spec.heightsMm) for (const v of row) if (v > top) top = v;
  return { widthMm: spec.widthMm, depthMm: pitch * Math.max(0, rows - 1), heightMm: top };
}

export function estimateTriangleCount(rows: number, cols: number): number {
  return 2 * (rows - 1) * (cols - 1) + 3 * (2 * cols + 2 * rows - 4);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 把网格在 XZ 平面上等比缩放到目标物理宽度（mm）并居中，厚度方向原样保留。
 * 用于 SVG 挤出这类来自 viewBox 单位、本身没有平面尺寸概念的网格：
 * 平面尺寸按目标宽度缩放，挤出深度已经是毫米，不该被一起缩放。
 */
export function fitToWidth(triangles: Triangle[], widthMm: number): Triangle[] {
  if (triangles.length === 0) return triangles;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  for (const t of triangles) {
    for (const v of t.vertices) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[2] < minZ) minZ = v[2];
      if (v[2] > maxZ) maxZ = v[2];
      if (v[1] < minY) minY = v[1];
    }
  }
  const span = maxX - minX;
  if (span <= 0) return triangles;
  const k = widthMm / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return triangles.map((t) => {
    const place = (v: [number, number, number]): [number, number, number] => [
      (v[0] - cx) * k,
      v[1] - minY,
      (v[2] - cz) * k,
    ];
    const [a, b, c] = t.vertices;
    return { ...t, vertices: [place(a), place(b), place(c)] };
  });
}
