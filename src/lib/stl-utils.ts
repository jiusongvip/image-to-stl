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

// 站点内部一律用 Y 作为厚度轴（Three.js 的相机与网格都以 Y 朝上），
// 但切片软件把 Z 当作竖直方向。写文件时统一绕 X 轴转 -90°，
// 让浮雕在切片器里平躺朝上，不需要用户手动旋转。
// (x, y, z) -> (x, -z, y) 的行列式为 +1，是纯旋转，绕序保持不变。
export function toSlicerSpace<T extends { normal: [number, number, number]; vertices: [number, number, number][] }>(
  triangles: T[],
): T[] {
  return triangles.map((t) => ({
    ...t,
    normal: [t.normal[0], -t.normal[2], t.normal[1]] as [number, number, number],
    vertices: t.vertices.map(
      (v) => [v[0], -v[2], v[1]] as [number, number, number],
    ),
  }));
}

// Write binary STL file to a Blob
export function writeBinaryStl(triangles: Triangle[], modelName: string): Blob {
  triangles = toSlicerSpace(triangles);
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
