import { computeNormal, smoothHeightmap, writeBinaryStl, type Triangle } from "./stl-utils";

export type LithophaneShape = "flat" | "curved" | "spherical";

export interface LithophaneParams {
  minThickness: number; // mm, thinnest point (bright)
  maxThickness: number; // mm, thickest point (dark)
  borderWidth: number; // mm, solid border around the image
  borderThickness: number; // mm, border solid height
  width: number; // mm, physical width
  height: number; // mm, physical height
  shape: LithophaneShape;
  curveRadius: number; // mm, radius of curvature (curved/spherical)
}

export function generateLithophaneTriangles(
  imageData: ImageData,
  params: LithophaneParams,
  scale: number = 1,
): Triangle[] {
  const { data: pixels, width: iw, height: ih } = imageData;
  const { minThickness, maxThickness, borderWidth, borderThickness, width, height, shape } = params;

  const triangles: Triangle[] = [];
  const w = Math.min(iw, Math.floor(256 * scale));
  const h = Math.min(ih, Math.floor(256 * scale));

  // Build thickness map (bright = thin, dark = thick for lithophane)
  const thicknesses: number[][] = Array.from({ length: h }, () => Array(w).fill(0));
  const thicknessRange = maxThickness - minThickness;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = Math.floor((x / w) * iw);
      const py = Math.floor((y / h) * ih);
      const idx = (py * iw + px) * 4;
      const gray = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3 / 255;
      // Bright pixel → thin, dark pixel → thick
      thicknesses[y][x] = minThickness + thicknessRange * (1 - gray);
    }
  }

  smoothHeightmap(thicknesses, 0.8);

  const pixelW = width / w;
  const pixelH = height / h;
  const bx = Math.floor(borderWidth / pixelW);
  const by = Math.floor(borderWidth / pixelH);

  // Generate front surface triangles (lithophane face)
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const x0 = (x - w / 2) * pixelW;
      const x1 = ((x + 1) - w / 2) * pixelW;
      const z0 = (y - h / 2) * pixelH;
      const z1 = ((y + 1) - h / 2) * pixelH;

      const t00 = getThickness(thicknesses, x, y, w, h, shape, params.curveRadius, x0, z0, pixelW, pixelH);
      const t10 = getThickness(thicknesses, x + 1, y, w, h, shape, params.curveRadius, x1, z0, pixelW, pixelH);
      const t01 = getThickness(thicknesses, x, y + 1, w, h, shape, params.curveRadius, x0, z1, pixelW, pixelH);
      const t11 = getThickness(thicknesses, x + 1, y + 1, w, h, shape, params.curveRadius, x1, z1, pixelW, pixelH);

      const v00: [number, number, number] = [x0, t00, z0];
      const v10: [number, number, number] = [x1, t10, z0];
      const v01: [number, number, number] = [x0, t01, z1];
      const v11: [number, number, number] = [x1, t11, z1];

      triangles.push({ normal: computeNormal(v00, v10, v11), vertices: [v00, v10, v11] });
      triangles.push({ normal: computeNormal(v00, v11, v01), vertices: [v00, v11, v01] });
    }
  }

  // Generate border faces
  const halfW = (w / 2) * pixelW + borderWidth;
  const halfH = (h / 2) * pixelH + borderWidth;
  const borderY = borderThickness;

  // Bottom plane
  const bY = 0;
  triangles.push({ normal: [0, -1, 0], vertices: [[-halfW, bY, -halfH], [halfW, bY, halfH], [halfW, bY, -halfH]] });
  triangles.push({ normal: [0, -1, 0], vertices: [[-halfW, bY, -halfH], [-halfW, bY, halfH], [halfW, bY, halfH]] });

  // Four side walls of the border
  const bh = borderY;
  // Front edge
  triangles.push(
    { normal: [0, 0, 1], vertices: [[-halfW, bY, halfH], [-halfW, bh, halfH], [halfW, bh, halfH]] },
  );
  triangles.push(
    { normal: [0, 0, 1], vertices: [[-halfW, bY, halfH], [halfW, bh, halfH], [halfW, bY, halfH]] },
  );
  // Back edge
  triangles.push(
    { normal: [0, 0, -1], vertices: [[halfW, bY, -halfH], [halfW, bh, -halfH], [-halfW, bh, -halfH]] },
  );
  triangles.push(
    { normal: [0, 0, -1], vertices: [[halfW, bY, -halfH], [-halfW, bh, -halfH], [-halfW, bY, -halfH]] },
  );
  // Left edge
  triangles.push(
    { normal: [-1, 0, 0], vertices: [[-halfW, bY, -halfH], [-halfW, bh, -halfH], [-halfW, bh, halfH]] },
  );
  triangles.push(
    { normal: [-1, 0, 0], vertices: [[-halfW, bY, -halfH], [-halfW, bh, halfH], [-halfW, bY, halfH]] },
  );
  // Right edge
  triangles.push(
    { normal: [1, 0, 0], vertices: [[halfW, bY, halfH], [halfW, bh, halfH], [halfW, bh, -halfH]] },
  );
  triangles.push(
    { normal: [1, 0, 0], vertices: [[halfW, bY, halfH], [halfW, bh, -halfH], [halfW, bY, -halfH]] },
  );

  return triangles;
}

function getThickness(
  thicknesses: number[][],
  x: number,
  y: number,
  w: number,
  h: number,
  shape: LithophaneShape,
  curveRadius: number,
  worldX: number,
  worldZ: number,
  pixelW: number,
  pixelH: number,
): number {
  const cx = Math.min(Math.max(x, 0), w - 1);
  const cy = Math.min(Math.max(y, 0), h - 1);
  const baseThickness = thicknesses[cy][cx];

  if (shape === "flat") return baseThickness;

  // Curved: bend the lithophane surface into an arc
  if (shape === "curved") {
    const halfH = (h / 2) * pixelH;
    const angle = (worldZ / halfH) * (Math.PI / 4); // 45 degrees total arc
    const r = curveRadius || 60;
    const curvatureOffset = r * (1 - Math.cos(angle));
    return baseThickness + curvatureOffset;
  }

  // Spherical: dome the surface
  if (shape === "spherical") {
    const halfW = (w / 2) * pixelW;
    const halfH = (h / 2) * pixelH;
    const dist = Math.sqrt((worldX / halfW) ** 2 + (worldZ / halfH) ** 2);
    const r = curveRadius || 80;
    const curvatureOffset = r * (1 - Math.cos(Math.min(dist, 1) * (Math.PI / 6)));
    return baseThickness + curvatureOffset;
  }

  return baseThickness;
}

// Generate STL blob from image data and params
export function generateLithophaneStl(
  imageData: ImageData,
  params: LithophaneParams,
  fileName: string,
  scale?: number,
): Blob {
  const triangles = generateLithophaneTriangles(imageData, params, scale);
  return writeBinaryStl(triangles, fileName);
}
