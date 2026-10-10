// SVG path parser and triangulator for 2D polygon extrusion to 3D STL

import earcut from "earcut";
import { computeNormal, type Triangle } from "./stl-utils";

export interface Point2D {
  x: number;
  y: number;
}

export interface Polygon {
  points: Point2D[];
}

// Parse SVG path data into closed polygons
// Returns array of polygons (each polygon is a closed loop)
export function parseSvgPath(pathData: string): Polygon[] {
  const polygons: Polygon[] = [];
  let current: Polygon = { points: [] };

  // Normalize: remove extra whitespace, split commands
  const normalized = pathData
    .replace(/,/g, " ")
    .replace(/([a-zA-Z])/g, "|$1|")
    .replace(/\|+/g, "|")
    .replace(/^\|/, "")
    .replace(/\|$/, "");

  const tokens = normalized.split("|").filter(Boolean).flatMap(part => part.trim().split(/\s+/).filter(Boolean));

  let pos = 0;
  let cx = 0, cy = 0; // current point
  let subStartX = 0, subStartY = 0; // start of current sub-path
  let prevCmd = "";

  while (pos < tokens.length) {
    const cmd = tokens[pos++];
    if (!/[a-zA-Z]/.test(cmd.charAt(0))) continue;

    const isUpper = cmd === cmd.toUpperCase();
    const type = cmd.toLowerCase();

    // Get numeric args for this command
    const args: number[] = [];
    while (pos < tokens.length && /^[0-9.eE+\-]+$/.test(tokens[pos])) {
      args.push(parseFloat(tokens[pos++]));
    }

    switch (type) {
      case "m": { // move
        for (let i = 0; i < args.length; i += 2) {
          const x = isUpper ? args[i] : cx + args[i];
          const y = isUpper ? args[i + 1] : cy + args[i + 1];
          if (i === 0) {
            // First coord pair: save existing polygon, start new sub-path
            if (current.points.length > 2) {
              polygons.push(current);
            }
            current = { points: [{ x, y }] };
            cx = x; cy = y;
            subStartX = x; subStartY = y;
          } else {
            // Subsequent pairs: implicit line-to (SVG spec)
            current.points.push({ x, y });
            cx = x; cy = y;
          }
        }
        break;
      }
      case "l": { // line
        for (let i = 0; i < args.length; i += 2) {
          cx = isUpper ? args[i] : cx + args[i];
          cy = isUpper ? args[i + 1] : cy + args[i + 1];
          current.points.push({ x: cx, y: cy });
        }
        break;
      }
      case "h": { // horizontal line
        for (let i = 0; i < args.length; i++) {
          cx = isUpper ? args[i] : cx + args[i];
          current.points.push({ x: cx, y: cy });
        }
        break;
      }
      case "v": { // vertical line
        for (let i = 0; i < args.length; i++) {
          cy = isUpper ? args[i] : cy + args[i];
          current.points.push({ x: cx, y: cy });
        }
        break;
      }
      case "c": { // cubic bezier
        for (let i = 0; i < args.length; i += 6) {
          const cp1x = isUpper ? args[i] : cx + args[i];
          const cp1y = isUpper ? args[i + 1] : cy + args[i + 1];
          const cp2x = isUpper ? args[i + 2] : cx + args[i + 2];
          const cp2y = isUpper ? args[i + 3] : cy + args[i + 3];
          const ex = isUpper ? args[i + 4] : cx + args[i + 4];
          const ey = isUpper ? args[i + 5] : cy + args[i + 5];
          sampleBezier(cx, cy, cp1x, cp1y, cp2x, cp2y, ex, ey, current);
          cx = ex; cy = ey;
          current.points.push({ x: cx, y: cy });
        }
        break;
      }
      case "s": { // smooth cubic bezier
        for (let i = 0; i < args.length; i += 4) {
          let cp1x: number, cp1y: number;
          if (prevCmd === "c" || prevCmd === "s") {
            const last = current.points[current.points.length - 1];
            cp1x = 2 * cx - (current.points[current.points.length - 2]?.x ?? cx);
            cp1y = 2 * cy - (current.points[current.points.length - 2]?.y ?? cy);
          } else {
            cp1x = cx; cp1y = cy;
          }
          const cp2x = isUpper ? args[i] : cx + args[i];
          const cp2y = isUpper ? args[i + 1] : cy + args[i + 1];
          const ex = isUpper ? args[i + 2] : cx + args[i + 2];
          const ey = isUpper ? args[i + 3] : cy + args[i + 3];
          sampleBezier(cx, cy, cp1x, cp1y, cp2x, cp2y, ex, ey, current);
          cx = ex; cy = ey;
          current.points.push({ x: cx, y: cy });
        }
        break;
      }
      case "q": { // quadratic bezier
        for (let i = 0; i < args.length; i += 4) {
          const cpx = isUpper ? args[i] : cx + args[i];
          const cpy = isUpper ? args[i + 1] : cy + args[i + 1];
          const ex = isUpper ? args[i + 2] : cx + args[i + 2];
          const ey = isUpper ? args[i + 3] : cy + args[i + 3];
          // Convert to cubic
          const cp1x = cx + (2 / 3) * (cpx - cx);
          const cp1y = cy + (2 / 3) * (cpy - cy);
          const cp2x = ex + (2 / 3) * (cpx - ex);
          const cp2y = ey + (2 / 3) * (cpy - ey);
          sampleBezier(cx, cy, cp1x, cp1y, cp2x, cp2y, ex, ey, current);
          cx = ex; cy = ey;
          current.points.push({ x: cx, y: cy });
        }
        break;
      }
      case "t": { // smooth quadratic bezier
        for (let i = 0; i < args.length; i += 2) {
          let cpx: number, cpy: number;
          if (prevCmd === "q" || prevCmd === "t") {
            const last2 = current.points[current.points.length - 2];
            cpx = 2 * cx - (last2?.x ?? cx);
            cpy = 2 * cy - (last2?.y ?? cy);
          } else {
            cpx = cx; cpy = cy;
          }
          const ex = isUpper ? args[i] : cx + args[i];
          const ey = isUpper ? args[i + 1] : cy + args[i + 1];
          const cp1x = cx + (2 / 3) * (cpx - cx);
          const cp1y = cy + (2 / 3) * (cpy - cy);
          const cp2x = ex + (2 / 3) * (cpx - ex);
          const cp2y = ey + (2 / 3) * (cpy - ey);
          sampleBezier(cx, cy, cp1x, cp1y, cp2x, cp2y, ex, ey, current);
          cx = ex; cy = ey;
          current.points.push({ x: cx, y: cy });
        }
        break;
      }
      case "a": { // elliptical arc
        for (let i = 0; i + 6 < args.length; i += 7) {
          const rx = args[i], ry = args[i + 1];
          if (rx === 0 || ry === 0) {
            // 半径为 0 时 SVG 规范退化为直线
            cx = isUpper ? args[i + 5] : cx + args[i + 5];
            cy = isUpper ? args[i + 6] : cy + args[i + 6];
            current.points.push({ x: cx, y: cy });
            continue;
          }
          const ex = isUpper ? args[i + 5] : cx + args[i + 5];
          const ey = isUpper ? args[i + 6] : cy + args[i + 6];
          sampleArc(cx, cy, rx, ry, (args[i + 2] * Math.PI) / 180, args[i + 3], args[i + 4], ex, ey, current);
          cx = ex; cy = ey;
          current.points.push({ x: cx, y: cy });
        }
        break;
      }
      case "z": { // close path
        if (current.points.length > 0) {
          current.points.push({ x: subStartX, y: subStartY });
          if (current.points.length > 2) {
            polygons.push(current);
          }
        }
        current = { points: [] };
        cx = subStartX; cy = subStartY;
        break;
      }
    }
    prevCmd = type;
  }

  // Push any remaining polygon
  if (current.points.length > 2) {
    // If not explicitly closed, close it
    const first = current.points[0];
    const last = current.points[current.points.length - 1];
    if (first.x !== last.x || first.y !== last.y) {
      current.points.push({ x: first.x, y: first.y });
    }
    polygons.push(current);
  }

  return polygons;
}

// 端点式圆弧 → 圆心式（SVG 规范 F.6.5.2），再按每 1/8 象限一个点采样。
function sampleArc(
  x1: number, y1: number,
  rxIn: number, ryIn: number,
  rot: number,
  largeArc: number, sweep: number,
  x2: number, y2: number,
  polygon: Polygon,
): void {
  if (x1 === x2 && y1 === y2) return;

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = den === 0 ? 0 : sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const ocx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const ocy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const cl = Math.max(-1, Math.min(1, dot / (len || 1)));
    const a = Math.acos(cl);
    return ux * vy - uy * vx < 0 ? -a : a;
  };

  const sx = (x1p - cxp) / rx;
  const sy = (y1p - cyp) / ry;
  const theta1 = angle(1, 0, sx, sy);
  let dtheta = angle(sx, sy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (sweep === 0 && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep === 1 && dtheta < 0) dtheta += 2 * Math.PI;

  const steps = Math.max(2, Math.ceil((Math.abs(dtheta) / (Math.PI / 2)) * 8));
  for (let i = 1; i <= steps; i++) {
    const t = theta1 + (dtheta * i) / steps;
    const px = rx * Math.cos(t);
    const py = ry * Math.sin(t);
    polygon.points.push({ x: cos * px - sin * py + ocx, y: sin * px + cos * py + ocy });
  }
}

function sampleBezier(
  x0: number, y0: number,
  cp1x: number, cp1y: number,
  cp2x: number, cp2y: number,
  x1: number, y1: number,
  polygon: Polygon,
  segments = 8,
): void {
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * mt * x0 + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * x1;
    const y = mt * mt * mt * y0 + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * y1;
    polygon.points.push({ x, y });
  }
}

// 判断点是否在环内（奇偶射线法，与绕序无关）
function pointInRing(p: Point2D, ring: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(ring: Point2D[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function boundsOf(ring: Point2D[]): Bounds {
  const b: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of ring) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

function covers(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.maxX >= inner.maxX &&
    outer.minY <= inner.minY &&
    outer.maxY >= inner.maxY
  );
}

/**
 * SVG 用嵌套表达孔：被奇数个轮廓包住的区域是空的（字母 O、甜甜圈）。
 * 按包含关系分层后返回 [外轮廓, ...它的孔] 分组，偶数层是实体、奇数层是孔；
 * 孔里的岛（第 2 层）会自成一组，切片器把它当成同一零件里的第二个封闭壳。
 */
function groupRings(rings: Point2D[][]): Point2D[][][] {
  const layers = rings.map((ring) => ({
    ring,
    area: ringArea(ring),
    bounds: boundsOf(ring),
    parent: -1,
    depth: 0,
  }));
  const order = layers.map((_, i) => i).sort((a, b) => layers[b].area - layers[a].area);

  for (const i of order) {
    const me = layers[i];
    let best = -1;
    for (const j of order) {
      if (j === i || layers[j].area <= me.area) continue; // 只可能被更大的轮廓包住
      if (!covers(layers[j].bounds, me.bounds)) continue;
      if (!pointInRing(me.ring[0], layers[j].ring)) continue;
      if (best === -1 || layers[j].area < layers[best].area) best = j;
    }
    me.parent = best;
    // 面积更大的轮廓先处理完，父层的 depth 此时一定已知
    me.depth = best === -1 ? 0 : layers[best].depth + 1;
  }

  const holesOf = new Map<number, Point2D[][]>();
  for (const i of order) {
    const me = layers[i];
    if (me.depth % 2 !== 1) continue;
    const list = holesOf.get(me.parent) || [];
    list.push(me.ring);
    holesOf.set(me.parent, list);
  }

  const groups: Point2D[][][] = [];
  for (const i of order) {
    if (layers[i].depth % 2 !== 0) continue;
    groups.push([layers[i].ring, ...(holesOf.get(i) || [])]);
  }
  return groups;
}

// Determine if polygon is clockwise
function isClockwise(points: Point2D[]): boolean {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    sum += (next.x - curr.x) * (next.y + curr.y);
  }
  return sum > 0;
}

// SVG 约定与曲线采样都会把同一个点写两遍：`Z` 会追加首点，bezier 分支在
// sampleBezier 已经推到 t=1 之后再 push 一次终点。留着重复点会让耳切和侧壁
// 各生成一对退化三角形，导出后表现为非流形边 —— 切片器直接判坏。
function dedupeLoop(points: Point2D[]): Point2D[] {
  const EPS = 1e-7;
  const out: Point2D[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue;
    out.push(p);
  }
  while (out.length > 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first.x - last.x) < EPS && Math.abs(first.y - last.y) < EPS) out.pop();
    else break;
  }
  return out;
}

// 一圈边界 → 上下两条边之间的侧壁。绕序决定法线朝哪：
// 外轮廓走 CCW 得到朝外的壁，孔走 CW 得到朝孔洞里侧的壁。
function wallBand(triangles: Triangle[], ring: Point2D[], top: number, bottom: number): void {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    if (curr.x === next.x && curr.y === next.y) continue; // 退化边不生成侧壁，否则法线未定义

    const vTop0: [number, number, number] = [curr.x, top, curr.y];
    const vTop1: [number, number, number] = [next.x, top, next.y];
    const vBot0: [number, number, number] = [curr.x, bottom, curr.y];
    const vBot1: [number, number, number] = [next.x, bottom, next.y];

    const normal = computeNormal(vTop0, vBot1, vBot0);
    triangles.push({ normal, vertices: [vTop0, vBot1, vBot0] });
    triangles.push({ normal, vertices: [vTop0, vTop1, vBot1] });
  }
}

/**
 * 一组轮廓（第 0 个是外轮廓，其余是它的孔）挤成一个封闭实体。
 * 只缩放，不平移：每个多边形各自归心会把同一张图里的零件叠到原点上，
 * 拼好的 logo 就变成一堆互相穿插的块。整体居中交给导出时的 fitToWidth。
 */
function extrudeRings(
  rawRings: Point2D[][],
  extrusionHeight: number,
  baseY: number,
  scale: number,
): Triangle[] {
  const triangles: Triangle[] = [];

  const oriented = rawRings
    .map((r) => dedupeLoop(r))
    .filter((r) => r.length >= 3)
    .map((r) => r.map((p) => ({ x: p.x * scale, y: p.y * scale })))
    .map((r, i) => {
      // 外轮廓统一 CCW、孔统一 CW：盖面按输入的走序出三角形，侧壁走同一批点序，
      // 两边必须同向才能反向配对，网格才水密。
      const ccw = !isClockwise(r);
      const wantCcw = i === 0;
      return ccw === wantCcw ? r : [...r].reverse();
    });
  if (oriented.length === 0) return triangles;

  const coords: number[] = [];
  const verts: Point2D[] = [];
  const holeIndices: number[] = [];
  oriented.forEach((ring, ri) => {
    if (ri > 0) holeIndices.push(verts.length);
    for (const p of ring) {
      coords.push(p.x, p.y);
      verts.push(p);
    }
  });

  // earcut 保证输出在 (x, y) 平面里是 CCW；y 落到世界的 Z 轴后同一面片朝向翻成朝下，
  // 所以盖面翻序、底板保持原序，两者才各自朝外。
  const faces = earcut(coords, holeIndices.length ? holeIndices : null, 2);
  const top = baseY + extrusionHeight;
  const bottom = baseY;
  const at = (i: number, y: number): [number, number, number] => [verts[i].x, y, verts[i].y];

  for (let k = 0; k + 2 < faces.length; k += 3) {
    const a = faces[k], b = faces[k + 1], c = faces[k + 2];
    triangles.push({ normal: [0, 1, 0], vertices: [at(a, top), at(c, top), at(b, top)] });
    triangles.push({ normal: [0, -1, 0], vertices: [at(a, bottom), at(b, bottom), at(c, bottom)] });
  }

  for (const ring of oriented) wallBand(triangles, ring, top, bottom);

  return triangles;
}

// Extrude a polygon into a 3D mesh with given height
export function extrudePolygonToMesh(
  rawPoints: Point2D[],
  extrusionHeight: number,
  baseY: number,
  scale: number,
): Triangle[] {
  return extrudeRings([rawPoints], extrusionHeight, baseY, scale);
}

// 整份 SVG 的轮廓一起挤出：嵌套关系按填充规则解析，内圈留成孔
export function extrudeShapesToMesh(
  polygons: Polygon[],
  extrusionHeight: number,
  baseY: number,
  scale: number,
): Triangle[] {
  const rings = polygons.map((p) => p.points).filter((r) => r.length >= 3);
  const triangles: Triangle[] = [];
  for (const group of groupRings(rings)) {
    triangles.push(...extrudeRings(group, extrusionHeight, baseY, scale));
  }
  return triangles;
}

// Convert <polygon points="..."> to path data string
function polygonToPath(pointsStr: string): string {
  const trimmed = pointsStr.trim();
  if (!trimmed) return "";
  return `M ${trimmed} Z`;
}

// Convert <rect x y width height> to path data string
function rectToPath(attrs: Record<string, string>): string {
  const x = parseFloat(attrs.x || "0");
  const y = parseFloat(attrs.y || "0");
  const w = parseFloat(attrs.width || "0");
  const h = parseFloat(attrs.height || "0");
  if (w <= 0 || h <= 0) return "";

  // rx/ry 按 SVG 规范各自夹到宽/高的一半，只写 rx 时 ry 等于 rx
  const rx = Math.min(parseFloat(attrs.rx || "0") || 0, w / 2);
  const ryRaw = attrs.ry == null ? rx : parseFloat(attrs.ry) || 0;
  const ry = Math.min(ryRaw, h / 2);
  if (rx <= 0 || ry <= 0) {
    return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  }

  const arc = (ex: number, ey: number) => `A ${rx} ${ry} 0 0 1 ${ex} ${ey}`;
  return (
    `M ${x + rx} ${y} ` +
    `L ${x + w - rx} ${y} ${arc(x + w, y + ry)} ` +
    `L ${x + w} ${y + h - ry} ${arc(x + w - rx, y + h)} ` +
    `L ${x + rx} ${y + h} ${arc(x, y + h - ry)} ` +
    `L ${x} ${y + ry} ${arc(x + rx, y)} Z`
  );
}

// 圆/椭圆走四段三次贝塞尔（kappa = 4/3·(√2−1)）而不是 SVG 的 A 弧线命令：
// 这段逼近和矢量编辑器导出的圆是同一条曲线，采样点也比弧线更均匀。
const KAPPA = 0.5522847498307936;

function ellipseToPath(cx: number, cy: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return "";
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return (
    `M ${cx - rx} ${cy} ` +
    `C ${cx - rx} ${cy - oy} ${cx - ox} ${cy - ry} ${cx} ${cy - ry} ` +
    `C ${cx + ox} ${cy - ry} ${cx + rx} ${cy - oy} ${cx + rx} ${cy} ` +
    `C ${cx + rx} ${cy + oy} ${cx + ox} ${cy + ry} ${cx} ${cy + ry} ` +
    `C ${cx - ox} ${cy + ry} ${cx - rx} ${cy + oy} ${cx - rx} ${cy} Z`
  );
}

// <line> 本身零面积，挤出会得到空网格；按描边宽度摊成一条有实体的窄带。
function lineToPath(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-9 || w <= 0) return "";
  const ux = ((y2 - y1) / len) * (w / 2);
  const uy = -((x2 - x1) / len) * (w / 2);
  return (
    `M ${x1 + ux} ${y1 + uy} L ${x2 + ux} ${y2 + uy} ` +
    `L ${x2 - ux} ${y2 - uy} L ${x1 - ux} ${y1 - uy} Z`
  );
}

// Parse SVG file content and extract all path data (including polygon and rect elements)
// Uses DOMParser for reliable XML parsing, with regex fallback
// SVG transform 列表：[a,b,c,d,e,f] 表示 x' = a·x + c·y + e, y' = b·x + d·y + f。
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mulMat(A: Mat, B: Mat): Mat {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

function parseTransform(raw: string | null): Mat {
  if (!raw) return IDENTITY;
  let m: Mat = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const v = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (v.some(Number.isNaN)) continue;
    let t: Mat = IDENTITY;
    switch (match[1].toLowerCase()) {
      case "matrix":
        if (v.length >= 6) t = [v[0], v[1], v[2], v[3], v[4], v[5]];
        break;
      case "translate":
        t = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
        break;
      case "scale":
        t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = ((v[0] || 0) * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        if (v.length >= 3) {
          const ox = v[1] || 0, oy = v[2] || 0;
          t = mulMat(mulMat([1, 0, 0, 1, ox, oy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -ox, -oy]);
        } else {
          t = [c, s, -s, c, 0, 0];
        }
        break;
      }
      case "skewx":
        t = [1, 0, Math.tan(((v[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewy":
        t = [1, Math.tan(((v[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mulMat(m, t);
  }
  return m;
}

// 嵌套的 transform 是复合的：从 <svg> 一路乘到元素自身，顺序不能反。
function accumulatedMatrix(el: Element): Mat {
  const chain: Element[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
  let m: Mat = IDENTITY;
  for (let i = chain.length - 1; i >= 0; i--) {
    m = mulMat(m, parseTransform(chain[i].getAttribute("transform")));
  }
  return m;
}

function applyMatrix(points: Point2D[], m: Mat): Point2D[] {
  return points.map((p) => ({
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  }));
}

interface SvgShape {
  d: string;
  matrix: Mat;
}

// 一个形状 = 一段局部坐标路径 + 它所在坐标系到用户坐标的矩阵
function collectShapes(svgString: string): SvgShape[] {
  const shapes: SvgShape[] = [];
  const push = (d: string | null, matrix: Mat) => {
    if (d && d.trim()) shapes.push({ d: d.trim(), matrix });
  };

  // Try DOMParser first (most reliable for valid XML/SVG)
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    const parseError = doc.querySelector("parsererror");

    if (!parseError) {
      // Extract viewBox for background rect skipping
      const svgEl = doc.documentElement;
      const vbAttr = svgEl.getAttribute("viewBox");
      let vbW = 0, vbH = 0;
      if (vbAttr) {
        const parts = vbAttr.split(/[\s,]+/).map(Number);
        if (parts.length === 4) { vbW = parts[2]; vbH = parts[3]; }
      }

      // <path d="...">
      doc.querySelectorAll("path").forEach((el) => push(el.getAttribute("d"), accumulatedMatrix(el)));

      // <polygon points="...">
      doc.querySelectorAll("polygon").forEach((el) => {
        const pts = el.getAttribute("points");
        if (pts && pts.trim()) push(polygonToPath(pts), accumulatedMatrix(el));
      });

      // <rect> (skip full-viewBox background rects)
      doc.querySelectorAll("rect").forEach((el) => {
        const w = parseFloat(el.getAttribute("width") || "0");
        const h = parseFloat(el.getAttribute("height") || "0");
        if (vbW > 0 && vbH > 0 && w >= vbW * 0.9 && h >= vbH * 0.9) return;
        const attrs: Record<string, string> = {};
        for (const name of ["x", "y", "width", "height", "rx", "ry"]) {
          const v = el.getAttribute(name);
          if (v) attrs[name] = v;
        }
        push(rectToPath(attrs), accumulatedMatrix(el));
      });

      const num = (el: Element, name: string, fallback = 0) => {
        const v = parseFloat(el.getAttribute(name) || "");
        return Number.isFinite(v) ? v : fallback;
      };

      // <circle> and <ellipse>
      doc.querySelectorAll("circle").forEach((el) => {
        const r = num(el, "r");
        if (r <= 0) return;
        push(ellipseToPath(num(el, "cx"), num(el, "cy"), r, r), accumulatedMatrix(el));
      });
      doc.querySelectorAll("ellipse").forEach((el) => {
        push(ellipseToPath(num(el, "cx"), num(el, "cy"), num(el, "rx"), num(el, "ry")), accumulatedMatrix(el));
      });

      // <line> — a bare line has no area, so give it its stroke width
      doc.querySelectorAll("line").forEach((el) => {
        push(
          lineToPath(
            num(el, "x1"),
            num(el, "y1"),
            num(el, "x2"),
            num(el, "y2"),
            num(el, "stroke-width", 1),
          ),
          accumulatedMatrix(el),
        );
      });

      if (shapes.length > 0) {
        return shapes;
      }
    } else {
      // SVG parse error, fall back to regex
    }
  } catch (e) {
    // DOMParser failed, fall back to regex
  }

  const attrMatrix = (attrStr: string): Mat => {
    const m = /transform\s*=\s*["']([^"']*)["']/i.exec(attrStr);
    return m ? parseTransform(m[1]) : IDENTITY;
  };

  // Regex fallback (for malformed SVGs that DOMParser can't handle)
  const pathRegex = /<path\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(svgString)) !== null) {
    const d = /\bd\s*=\s*"([^"]*)"/i.exec(match[1]) || /\bd\s*=\s*'([^']*)'/i.exec(match[1]);
    if (d) push(d[1], attrMatrix(match[1]));
  }

  const polyRegex = /<polygon\b([^>]*)>/gi;
  while ((match = polyRegex.exec(svgString)) !== null) {
    const pts = /\bpoints\s*=\s*"([^"]*)"/i.exec(match[1]) || /\bpoints\s*=\s*'([^']*)'/i.exec(match[1]);
    if (pts) push(polygonToPath(pts[1]), attrMatrix(match[1]));
  }

  const rectRegex = /<rect\b([^>]*)>/gi;
  while ((match = rectRegex.exec(svgString)) !== null) {
    const attrStr = match[1];
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)\s*=\s*["']([^"']*)["']/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrStr)) !== null) attrs[attrMatch[1]] = attrMatch[2];
    const w = parseFloat(attrs.width || "0");
    const h = parseFloat(attrs.height || "0");
    const vbMatch = svgString.match(/viewBox=["']([^"']+)["']/);
    if (vbMatch) {
      const vbParts = vbMatch[1].split(/[\s,]+/).map(Number);
      if (vbParts.length === 4 && w >= vbParts[2] * 0.9 && h >= vbParts[3] * 0.9) continue;
    }
    push(rectToPath(attrs), attrMatrix(attrStr));
  }

  return shapes;
}

// 带 transform 的完整解析：路径点已经换算到 SVG 用户坐标，可直接挤出。
// 渐变是连续色调而不是轮廓：挤出成一块平板会把明暗信息全丢掉，
// 所以带渐变的 SVG 交给高度图路线处理。
export function hasGradientPaint(svgString: string): boolean {
  return /<(linear|radial)Gradient\b/i.test(svgString);
}

export function extractShapesFromSvg(svgString: string): Polygon[] {
  const out: Polygon[] = [];
  for (const shape of collectShapes(svgString)) {
    for (const poly of parseSvgPath(shape.d)) {
      if (poly.points.length < 3) continue;
      out.push({ points: applyMatrix(poly.points, shape.matrix) });
    }
  }
  return out;
}

