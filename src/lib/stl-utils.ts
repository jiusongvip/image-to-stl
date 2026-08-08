// Shared utilities for STL file generation

export interface Triangle {
  normal: [number, number, number];
  vertices: [[number, number, number], [number, number, number], [number, number, number]];
}

export function computeNormal(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): [number, number, number] {
  const u: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal: [number, number, number] = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const len = Math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2);
  if (len < 1e-10) return [0, 0, 1];
  return [normal[0] / len, normal[1] / len, normal[2] / len];
}

// Smooth a 2D array in-place using box blur
export function smoothHeightmap(heights: number[][], radius: number): void {
  const h = heights.length;
  const w = heights[0].length;
  const copy = heights.map((row) => [...row]);
  const sr = Math.floor(radius);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = copy[y][x];
      let count = 1;
      for (let dy = -sr; dy <= sr; dy++) {
        for (let dx = -sr; dx <= sr; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            sum += copy[ny][nx];
            count++;
          }
        }
      }
      heights[y][x] = sum / count;
    }
  }
}

// Write binary STL file to a Blob
export function writeBinaryStl(triangles: Triangle[], modelName: string): Blob {
  const headerSize = 84;
  const triSize = 50;
  const buffer = new ArrayBuffer(headerSize + triangles.length * triSize);
  const view = new DataView(buffer);

  const name = modelName.substring(0, 79);
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, i < name.length ? name.charCodeAt(i) : 32);
  }
  view.setUint32(80, triangles.length, true);

  let offset = 84;
  for (const t of triangles) {
    const f32 = new Float32Array(t.normal.length + t.vertices.length * 3);
    f32[0] = t.normal[0];
    f32[1] = t.normal[1];
    f32[2] = t.normal[2];
    let vi = 3;
    for (const v of t.vertices) {
      f32[vi] = v[0];
      f32[vi + 1] = v[1];
      f32[vi + 2] = v[2];
      vi += 3;
    }
    const bytes = new Uint8Array(f32.buffer);
    for (let j = 0; j < 48; j++) {
      view.setUint8(offset + j, bytes[j]);
    }
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }

  return new Blob([buffer], { type: "application/octet-stream" });
}

// Download a Blob as a file
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Mesh decimation: merge nearby vertices that are too close
export function decimateMesh(
  heights: number[][],
  scaleX: number,
  scaleZ: number,
  targetRatio: number = 0.5,
): { triangles: Triangle[]; count: number } {
  const h = heights.length;
  const w = heights[0].length;
  const step = Math.max(1, Math.round(1 / targetRatio));

  const mapH = Math.ceil((h - 1) / step) + 1;
  const mapW = Math.ceil((w - 1) / step) + 1;
  const decimated: number[][] = Array.from({ length: mapH }, () => Array(mapW).fill(0));

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const sy = Math.min(y * step, h - 1);
      const sx = Math.min(x * step, w - 1);
      decimated[y][x] = heights[sy][sx];
    }
  }

  const triList: Triangle[] = [];
  for (let y = 0; y < mapH - 1; y++) {
    for (let x = 0; x < mapW - 1; x++) {
      const x0 = (x - (mapW - 1) / 2) * scaleX * step;
      const x1 = ((x + 1) - (mapW - 1) / 2) * scaleX * step;
      const z0 = (y - (mapH - 1) / 2) * scaleZ * step;
      const z1 = ((y + 1) - (mapH - 1) / 2) * scaleZ * step;

      const v00: [number, number, number] = [x0, decimated[y][x], z0];
      const v10: [number, number, number] = [x1, decimated[y][x + 1], z0];
      const v01: [number, number, number] = [x0, decimated[y + 1][x], z1];
      const v11: [number, number, number] = [x1, decimated[y + 1][x + 1], z1];

      triList.push({ normal: computeNormal(v00, v10, v11), vertices: [v00, v10, v11] });
      triList.push({ normal: computeNormal(v00, v11, v01), vertices: [v00, v11, v01] });
    }
  }

  return { triangles: triList, count: triList.length };
}
