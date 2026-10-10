import { writeBinaryStl, type Triangle } from "./stl-utils";
import { buildClosedSolid } from "./solid";

export type LithophaneShape = "flat" | "curved" | "spherical";

export interface LithophaneParams {
  minThickness: number; // mm, thinnest point (bright)
  maxThickness: number; // mm, thickest point (dark)
  borderWidth: number; // mm, solid border around the image
  borderThickness: number; // mm, border solid height
  width: number; // mm, image area width
  height: number; // mm, image area height
  shape: LithophaneShape;
  curveRadius: number; // mm, radius of curvature (curved/spherical)
}

/**
 * 石版灯面板 = 成像区 + 实心边框，合成一张厚度网格后交给 buildClosedSolid。
 * 两者共用同一个网格，因此边框与成像面之间不会出现悬空边界，
 * 导出的是封闭实体，切片器不需要修复开口。
 */
export function generateLithophaneTriangles(
  imageData: ImageData,
  params: LithophaneParams,
  scale: number = 1,
): Triangle[] {
  const { data: pixels, width: iw, height: ih } = imageData;
  const { minThickness, maxThickness, borderWidth, borderThickness, width, height, shape } = params;

  const totalW = width + 2 * borderWidth;
  const totalH = height + 2 * borderWidth;
  const cols = Math.max(8, Math.min(iw, Math.round(256 * scale)));
  const pitch = totalW / (cols - 1);
  const rows = Math.max(8, Math.round(totalH / pitch) + 1);

  const halfW = width / 2;
  const halfH = height / 2;
  const range = Math.max(0.01, maxThickness - minThickness);

  const heightsMm: number[][] = [];
  for (let gy = 0; gy < rows; gy++) {
    const zMm = (gy - (rows - 1) / 2) * pitch;
    const row: number[] = [];
    for (let gx = 0; gx < cols; gx++) {
      const xMm = (gx - (cols - 1) / 2) * pitch;
      if (Math.abs(xMm) > halfW || Math.abs(zMm) > halfH) {
        row.push(borderThickness + curvatureOffset(params, xMm, zMm));
        continue;
      }
      const px = Math.min(iw - 1, Math.floor(((xMm + halfW) / width) * iw));
      const py = Math.min(ih - 1, Math.floor(((zMm + halfH) / height) * ih));
      const i = (py * iw + px) * 4;
      const luma = (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
      // 亮处透光度低 → 做薄；暗处要显影 → 做厚
      row.push(minThickness + range * (1 - luma) + curvatureOffset(params, xMm, zMm));
    }
    heightsMm.push(row);
  }

  return buildClosedSolid({ heightsMm, widthMm: totalW });
}

function curvatureOffset(params: LithophaneParams, xMm: number, zMm: number): number {
  const { shape, width, height, curveRadius } = params;
  if (shape === "flat") return 0;

  if (shape === "curved") {
    const r = curveRadius || 60;
    const angle = (zMm / (height / 2)) * (Math.PI / 4);
    return r * (1 - Math.cos(angle));
  }

  const r = curveRadius || 80;
  const dist = Math.hypot(xMm / (width / 2), zMm / (height / 2));
  return r * (1 - Math.cos(Math.min(dist, 1) * (Math.PI / 6)));
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
