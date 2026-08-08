// SVG path parser and triangulator for 2D polygon extrusion to 3D STL

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

// Ear clipping triangulation for simple polygon
function triangulatePolygon(polygon: Point2D[]): [number, number, number][] {
  const indices: [number, number, number][] = [];
  if (polygon.length < 3) return indices;

  // Copy vertices for triangulation
  const verts = polygon.map((p, i) => ({ x: p.x, y: p.y, idx: i }));
  let remaining = [...verts];

  // Simple ear clipping
  let safety = 0;
  while (remaining.length > 3 && safety < 1000) {
    safety++;
    let earFound = false;

    for (let i = 0; i < remaining.length; i++) {
      const prev = remaining[(i - 1 + remaining.length) % remaining.length];
      const curr = remaining[i];
      const next = remaining[(i + 1) % remaining.length];

      // Check if this is a convex vertex
      const cross =
        (curr.x - prev.x) * (next.y - curr.y) - (curr.y - prev.y) * (next.x - curr.x);

      if (cross >= 0) { // Convex (counter-clockwise polygon)
        // Check if any other vertex is inside this triangle
        let isEar = true;
        for (const p of remaining) {
          if (p === prev || p === curr || p === next) continue;
          if (pointInTriangle(p, prev, curr, next)) {
            isEar = false;
            break;
          }
        }

        if (isEar) {
          indices.push([prev.idx, curr.idx, next.idx]);
          remaining.splice(i, 1);
          earFound = true;
          break;
        }
      }
    }

    if (!earFound) break; // Degenerate polygon
  }

  // Last triangle
  if (remaining.length === 3) {
    indices.push([remaining[0].idx, remaining[1].idx, remaining[2].idx]);
  }

  return indices;
}

function pointInTriangle(
  p: Point2D,
  a: Point2D,
  b: Point2D,
  c: Point2D,
): boolean {
  const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
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

// Extrude a polygon into a 3D mesh with given height
export function extrudePolygonToMesh(
  points: Point2D[],
  extrusionHeight: number,
  baseY: number,
  scale: number,
): Triangle[] {
  const triangles: Triangle[] = [];

  // Normalize points to center and scale
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  const normalized = points.map((p) => ({
    x: (p.x - cx) * scale,
    y: (p.y - cy) * scale,
  }));

  // Ensure counter-clockwise
  if (isClockwise(normalized)) normalized.reverse();

  const top = baseY + extrusionHeight;
  const bottom = baseY;

  // Triangulate top face
  const topIndices = triangulatePolygon(normalized);
  for (const [a, b, c] of topIndices) {
    const v0: [number, number, number] = [normalized[a].x, top, normalized[a].y];
    const v1: [number, number, number] = [normalized[b].x, top, normalized[b].y];
    const v2: [number, number, number] = [normalized[c].x, top, normalized[c].y];
    triangles.push({ normal: [0, 1, 0], vertices: [v0, v1, v2] });
  }

  // Triangulate bottom face (reverse winding)
  for (const [a, b, c] of topIndices) {
    const v0: [number, number, number] = [normalized[a].x, bottom, normalized[a].y];
    const v2: [number, number, number] = [normalized[b].x, bottom, normalized[b].y];
    const v1: [number, number, number] = [normalized[c].x, bottom, normalized[c].y];
    triangles.push({ normal: [0, -1, 0], vertices: [v0, v1, v2] });
  }

  // Side walls
  const n = normalized.length;
  for (let i = 0; i < n; i++) {
    const curr = normalized[i];
    const next = normalized[(i + 1) % n];

    const vTop0: [number, number, number] = [curr.x, top, curr.y];
    const vTop1: [number, number, number] = [next.x, top, next.y];
    const vBot0: [number, number, number] = [curr.x, bottom, curr.y];
    const vBot1: [number, number, number] = [next.x, bottom, next.y];

    const normal = computeNormal(vTop0, vBot1, vBot0);
    triangles.push({ normal, vertices: [vTop0, vBot1, vBot0] });
    triangles.push({ normal, vertices: [vTop0, vTop1, vBot1] });
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
  return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
}

// Parse SVG file content and extract all path data (including polygon and rect elements)
// Uses DOMParser for reliable XML parsing, with regex fallback
export function extractPathsFromSvg(svgString: string): string[] {
  const pathData: string[] = [];

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
      doc.querySelectorAll("path").forEach((el) => {
        const d = el.getAttribute("d");
        if (d && d.trim()) pathData.push(d.trim());
      });

      // <polygon points="...">
      doc.querySelectorAll("polygon").forEach((el) => {
        const pts = el.getAttribute("points");
        if (pts && pts.trim()) {
          const d = polygonToPath(pts);
          if (d) pathData.push(d);
        }
      });

      // <rect> (skip full-viewBox background rects)
      doc.querySelectorAll("rect").forEach((el) => {
        const w = parseFloat(el.getAttribute("width") || "0");
        const h = parseFloat(el.getAttribute("height") || "0");
        if (vbW > 0 && vbH > 0 && w >= vbW * 0.9 && h >= vbH * 0.9) return;
        const attrs: Record<string, string> = {};
        for (const name of ["x", "y", "width", "height"]) {
          const v = el.getAttribute(name);
          if (v) attrs[name] = v;
        }
        const d = rectToPath(attrs);
        if (d) pathData.push(d);
      });

      if (pathData.length > 0) {
        return pathData;
      }
    } else {
      // SVG parse error, fall back to regex
    }
  } catch (e) {
    // DOMParser failed, fall back to regex
  }

  // Regex fallback (for malformed SVGs that DOMParser can't handle)
  const pathRegex = /<path[^>]*\sd\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = pathRegex.exec(svgString)) !== null) pathData.push(match[1]);
  const pathRegex2 = /<path[^>]*\sd\s*=\s*'([^']*)'/gi;
  while ((match = pathRegex2.exec(svgString)) !== null) pathData.push(match[1]);

  const polyRegex = /<polygon[^>]*\spoints\s*=\s*"([^"]*)"/gi;
  while ((match = polyRegex.exec(svgString)) !== null) {
    const d = polygonToPath(match[1]);
    if (d) pathData.push(d);
  }
  const polyRegex2 = /<polygon[^>]*\spoints\s*=\s*'([^']*)'/gi;
  while ((match = polyRegex2.exec(svgString)) !== null) {
    const d = polygonToPath(match[1]);
    if (d) pathData.push(d);
  }

  const rectRegex = /<rect\b([^>]*)/gi;
  while ((match = rectRegex.exec(svgString)) !== null) {
    const attrStr = match[1];
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)\s*=\s*["']([^"']*)["']/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(attrStr)) !== null) attrs[attrMatch[1]] = attrMatch[2];
    const w = parseFloat(attrs.width || "0");
    const h = parseFloat(attrs.height || "0");
    const vbMatch = svgString.match(/viewBox=["']([^"']+)["']/);
    if (vbMatch) {
      const vbParts = vbMatch[1].split(/[\s,]+/).map(Number);
      if (vbParts.length === 4 && w >= vbParts[2] * 0.9 && h >= vbParts[3] * 0.9) continue;
    }
    const d = rectToPath(attrs);
    if (d) pathData.push(d);
  }

  return pathData;
}
