// 网格体检：直接跑站点真实的导出代码（src/lib/solid.ts 与 src/lib/lithophane.ts），
// 统计未配对边、体积朝向与物理尺寸，证明导出的是切片器可直接使用的封闭实体。
//
//   node scripts/check-mesh-closed.mjs
//
// 未配对边必须为 0；有符号体积必须为正（绕序朝外）。
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".mesh-probe");

let failed = 0;

await build({
  entryPoints: [
    join(root, "src/lib/solid.ts"),
    join(root, "src/lib/lithophane.ts"),
    join(root, "src/lib/stl-utils.ts"),
    join(root, "src/lib/svg-parser.ts"),
    join(root, "src/lib/cutter.ts"),
  ],
  bundle: true,
  format: "esm",
  outdir: out,
  platform: "neutral",
  logLevel: "error",
});

const solid = await import(pathToFileURL(join(out, "solid.js")).href);
const litho = await import(pathToFileURL(join(out, "lithophane.js")).href);
const stlUtils = await import(pathToFileURL(join(out, "stl-utils.js")).href);
const svgParser = await import(pathToFileURL(join(out, "svg-parser.js")).href);
const cutter = await import(pathToFileURL(join(out, "cutter.js")).href);
rmSync(out, { recursive: true, force: true });

const { sampleHeightGrid, buildClosedSolid, toHeightMm, gridShape, estimateTriangleCount } = solid;

/** 合成一张照片般的亮度图：亮脸 + 暗背景 + 中间调天空 */
function fakePhoto(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nx = x / w - 0.5;
      const ny = y / h - 0.45;
      const face = Math.exp(-(nx * nx + ny * ny) / 0.045);
      const sky = 0.35 + 0.25 * (1 - y / h);
      const v = Math.min(1, Math.max(0, sky * 0.55 + face * 0.85));
      const g = Math.round(v * 255);
      data[i] = g;
      data[i + 1] = g;
      data[i + 2] = g;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const v3key = (v) => `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;

function check(label, tris, expect, up = 1, expectVolume = null) {
  const edges = new Map();
  let bx = [Infinity, -Infinity];
  let by = [Infinity, -Infinity];
  let bz = [Infinity, -Infinity];
  let volume = 0;
  let minTop = Infinity;

  for (const t of tris) {
    const [p, q, r] = t.vertices;
    for (const v of t.vertices) {
      bx[0] = Math.min(bx[0], v[0]); bx[1] = Math.max(bx[1], v[0]);
      by[0] = Math.min(by[0], v[1]); by[1] = Math.max(by[1], v[1]);
      bz[0] = Math.min(bz[0], v[2]); bz[1] = Math.max(bz[1], v[2]);
    }
    if (t.normal[up] > 0.5) minTop = Math.min(minTop, Math.max(p[up], q[up], r[up]));
    // 有符号体积：绕序朝外时为正
    volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    const pairs = [[p, q], [q, r], [r, p]];
    for (const [a, b] of pairs) {
      const fwd = `${v3key(a)}>${v3key(b)}`;
      const rev = `${v3key(b)}>${v3key(a)}`;
      if (edges.get(rev)) edges.set(rev, edges.get(rev) - 1);
      else edges.set(fwd, (edges.get(fwd) || 0) + 1);
    }
  }

  let free = 0;
  edges.forEach((c) => { if (c > 0) free += c; });
  const dims = [bx[1] - bx[0], by[1] - by[0], bz[1] - bz[0]];

  const problems = [];
  if (free !== 0) problems.push(`${free} 条未配对边（开口壳体，切片器需要修复）`);
  if (!(volume > 0)) problems.push(`有符号体积 ${volume.toFixed(1)} ≤ 0（绕序朝内，模型是里外反的）`);
  if (!(minTop > 0)) problems.push(`最薄处顶面塌到 ${minTop.toFixed(4)}mm（零厚度面）`);
  for (const [i, want] of expect.entries()) {
    if (want === null) continue;
    if (Math.abs(dims[i] - want) > Math.max(0.02, want * 0.01)) problems.push(`第 ${"XYZ"[i]} 向尺寸 ${dims[i].toFixed(2)}mm，期望 ${want}mm`);
  }
  // 孔有没有真的空出来，只有体积能证明：尺寸一致、体积少一截才算数
  if (expectVolume !== null) {
    const off = Math.abs(volume - expectVolume) / expectVolume;
    if (off > 0.01) {
      problems.push(`体积 ${volume.toFixed(1)}mm³，期望 ${expectVolume.toFixed(1)}mm³（偏差 ${(off * 100).toFixed(1)}%）`);
    }
  }

  console.log(`\n### ${label}`);
  console.log(`  triangles : ${tris.length.toLocaleString()}`);
  console.log(`  size X×Y×Z: ${dims.map((d) => d.toFixed(2)).join(" × ")} mm   (${up === 2 ? "Z" : "Y"} = 浮雕厚度)`);
  console.log(`  free edges: ${free.toLocaleString()}`);
  console.log(`  volume    : ${volume.toFixed(1)} mm³  ${volume > 0 ? "朝外 ✓" : "朝内 ✗"}`);
  console.log(`  thinnest  : ${minTop.toFixed(3)} mm`);
  if (problems.length) {
    failed++;
    for (const p of problems) console.log(`  FAIL  ${p}`);
  } else {
    console.log("  PASS  水密封闭实体");
  }
}

// ── 1. 主页面的光栅转换链（与 ConverterTool 的下载路径一致）────────────
const photo = fakePhoto(640, 480); // 4:3
for (const res of ["low", "medium", "high", "ultra"]) {
  const maxCells = { low: 128, medium: 224, high: 320, ultra: 448 }[res];
  const heights = sampleHeightGrid(photo, { invert: false, removeBackground: false, smoothRadius: 2, maxCells });
  const spec = { heightsMm: toHeightMm(heights, 3), widthMm: 100 };
  const tris = buildClosedSolid(spec);
  const shape = gridShape(photo.width, photo.height, maxCells);
  check(`Heightmap 导出 @ ${res} — 100mm 宽，无底板，起伏 3mm`, tris, [100, 3, 75]);
  const est = estimateTriangleCount(shape.rows, shape.cols);
  if (Math.abs(est - tris.length) / est > 0.02) {
    failed++;
    console.log(`  FAIL  面数预估 ${est} 与实际 ${tris.length} 不符`);
  }
}

// ── 2. 石版灯面板 ────────────────────────────────────────────────
const lithoParams = {
  minThickness: 0.8,
  maxThickness: 3.2,
  borderWidth: 4,
  borderThickness: 3.2,
  width: 100,
  height: 75,
  shape: "flat",
  curveRadius: 60,
};
check(
  "Lithophane 导出 — 成像区 100×75mm + 4mm 边框",
  litho.generateLithophaneTriangles(photo, lithoParams, 1),
  [108, null, 83],
);
check(
  "Lithophane 导出 — curved 弧面",
  litho.generateLithophaneTriangles(photo, { ...lithoParams, shape: "curved" }, 1),
  [108, null, 83],
);

// ── 3. 反转与去背景不应破坏封闭性 ────────────────────────────────
const inverted = sampleHeightGrid(photo, { invert: true, removeBackground: true, smoothRadius: 1, maxCells: 224 });
// 反转 + 去背景后最亮点未必是纯白，Y 向（浮雕高度）落在 0..relief 之间即可。
check("Heightmap 导出 — invert + removeBackground", buildClosedSolid({ heightsMm: toHeightMm(inverted, 3), widthMm: 100 }), [100, null, 75]);

// ── 4. 切片器坐标系变换：浮雕应沿 Z 轴朝上，且变换不破坏封闭性 ─────
{
  const heights = sampleHeightGrid(photo, { invert: false, removeBackground: false, smoothRadius: 2, maxCells: 224 });
  const tris = stlUtils.toSlicerSpace(
    buildClosedSolid({ heightsMm: toHeightMm(heights, 3), widthMm: 100 }),
  );
  check("Heightmap 导出 — toSlicerSpace 之后（切片器看到的坐标）", tris, [100, 75, 3], 2);
}

// ── 5. SVG 挤出（CookieCutter 与主页 SVG 模式共用）─────────────────
{
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  check("SVG 挤出 — 正方形轮廓 100×100×3mm", svgParser.extrudePolygonToMesh(square, 3, 0, 10), [100, 3, 100]);

  const circle = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    circle.push({ x: 50 + 50 * Math.cos(a), y: 50 + 50 * Math.sin(a) });
  }
  check("SVG 挤出 — 圆形轮廓 Ø100×4mm", svgParser.extrudePolygonToMesh(circle, 4, 0, 1), [100, 4, 100]);

  // 两个分开的方块：整体跨度必须是 0..40，而不是各自居中后叠在原点上。
  const two = [
    ...svgParser.extrudePolygonToMesh([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 3, 0, 1),
    ...svgParser.extrudePolygonToMesh([{ x: 30, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 30, y: 10 }], 3, 0, 1),
  ];
  check("SVG 挤出 — 两个分离方块保持 40×10 的相对布局", two, [40, 3, 10]);
}

// ── 6. 真实 SVG 元素走完整解析链（rect 的 Z 会重复首点，贝塞尔圆弧会重复终点）──
{
  const cases = [
    ["<rect> 换算的闭合路径", "M 20 10 L 180 10 L 180 90 L 20 90 Z", [160, 3, 80]],
    ["<path> 贝塞尔圆（四段 C + Z）", "M 50 10 C 72.09 10 90 27.91 90 50 C 90 72.09 72.09 90 50 90 C 27.91 90 10 72.09 10 50 C 10 27.91 27.91 10 50 10 Z", [80, 3, 80]],
    ["<polygon> 换算的闭合路径", "M 0 0 100 0 50 87 Z", [100, 3, 87]],
    // A 命令：两段 180° 弧拼成整圆
    ["<path> 两段 A 弧拼成的圆", "M 10 50 A 40 40 0 1 0 90 50 A 40 40 0 1 0 10 50 Z", [80, 3, 80]],
    // 圆角矩形：四条直线夹四段 90° 弧，r=20，整体 100×60
    [
      "<path> 圆角矩形（四段 A 弧）",
      "M 20 0 L 80 0 A 20 20 0 0 1 100 20 L 100 40 A 20 20 0 0 1 80 60 L 20 60 A 20 20 0 0 1 0 40 L 0 20 A 20 20 0 0 1 20 0 Z",
      [100, 3, 60],
    ],
    // 半径为 0 时 SVG 规范规定按直线处理，不能因此丢掉这个点
    ["<path> A 半径为 0 退化为直线", "M 0 0 A 0 0 0 0 0 50 40 L 50 0 Z", [50, 3, 40]],
  ];
  for (const [label, d, expect] of cases) {
    const polys = svgParser.parseSvgPath(d);
    const tris = [];
    for (const poly of polys) {
      if (poly.points.length < 3) continue;
      tris.push(...svgParser.extrudePolygonToMesh(poly.points, 3, 0, 1));
    }
    check(`SVG 解析链 — ${label}`, tris, expect);
  }
}

// ── 6b. transform：形状必须落在整体坐标系里，不能各自躺在原地 ───────────
{
  const cases = [
    [
      "translate 把第二个方块挪到 (60,40)",
      '<svg viewBox="0 0 100 100"><path d="M 0 0 20 0 20 20 0 20 Z"/><path transform="translate(60 40)" d="M 0 0 20 0 20 20 0 20 Z"/></svg>',
      [80, 3, 60],
    ],
    [
      "scale(2) 把 20×20 放大成 40×40",
      '<svg viewBox="0 0 100 100"><path transform="scale(2)" d="M 0 0 20 0 20 20 0 20 Z"/></svg>',
      [40, 3, 40],
    ],
    [
      "rotate(90) 换轴：40×20 变 20×40",
      '<svg viewBox="0 0 100 100"><path transform="rotate(90)" d="M 0 0 40 0 40 20 0 20 Z"/></svg>',
      [20, 3, 40],
    ],
    [
      "rect + transform",
      '<svg viewBox="0 0 100 100"><rect x="0" y="0" width="30" height="10" transform="translate(10 50)"/></svg>',
      [30, 3, 10],
    ],
    [
      "rect rx/ry 圆角",
      '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="60" height="40" rx="10" ry="10"/></svg>',
      [60, 3, 40],
    ],
  ];
  for (const [label, svg, expect] of cases) {
    const tris = [];
    for (const poly of svgParser.extractShapesFromSvg(svg)) {
      tris.push(...svgParser.extrudePolygonToMesh(poly.points, 3, 0, 1));
    }
    check(`SVG transform — ${label}`, tris, expect);
  }
}

// ── 7. 饼干压模：纯环形墙带（无底板），凹角必须靠角平分线偏移闭合 ─────
{
  const star = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 50 : 22;
    star.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const cutterParams = { wallHeight: 25, wallThickness: 1.5 };
  check("Cookie cutter — 五角星墙带，高 25mm", cutter.buildCookieCutterMesh(star, cutterParams), [80, 25, null]);

  // 描图得到的轮廓方向不定，顺时针输入也得给出朝外的实体。40×60 输入按长边 80mm 归一，
  // 所以短边落在 X = 53.33mm。
  check("Cookie cutter — 顺时针方形轮廓", cutter.buildCookieCutterMesh([[0, 0], [0, 60], [40, 60], [40, 0]], { ...cutterParams, wallHeight: 20 }), [53.33, 20, 80]);
}

// ── 8. 嵌套轮廓：内圈必须真空出来（字母 O、甜甜圈）───────────────────
{
  const K = 0.5522847498307936;
  const circle = (cx, cy, r) => {
    const k = K * r;
    return (
      `M ${cx - r} ${cy} C ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} ` +
      `C ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} ` +
      `C ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} ` +
      `C ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} Z`
    );
  };
  const rings = (...ds) => ds.flatMap((d) => svgParser.parseSvgPath(d));
  // 采样后的折线面积：孔应当正好从外轮廓里扣掉这一块
  const areaOf = (poly) => {
    const p = poly.points;
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  };
  const polys = (...ds) => rings(...ds);
  const area = (...ds) => rings(...ds).reduce((sum, poly) => sum + areaOf(poly), 0);

  {
    const outer = circle(50, 50, 50), hole = circle(50, 50, 25);
    const h = 3;
    check(
      "SVG 带孔 — 甜甜圈 Ø100、孔 Ø50",
      svgParser.extrudeShapesToMesh(polys(outer, hole), h, 0, 1),
      [100, h, 100],
      1,
      (area(outer) - area(hole)) * h,
    );
    // 孔写在外圈前面：分组只能靠包含关系，不能靠文档顺序
    check(
      "SVG 带孔 — 孔写在前面也认得出",
      svgParser.extrudeShapesToMesh(polys(hole, outer), h, 0, 1),
      [100, h, 100],
      1,
      (area(outer) - area(hole)) * h,
    );
  }

  {
    const h = 4;
    const outer = circle(50, 50, 50), hole = circle(50, 50, 40), island = circle(50, 50, 20);
    check(
      "SVG 带孔 — 孔里的岛自成实体（同心三环）",
      svgParser.extrudeShapesToMesh(polys(outer, hole, island), h, 0, 1),
      [100, h, 100],
      1,
      (area(outer) - area(hole) + area(island)) * h,
    );
  }

  {
    const h = 3;
    const a = circle(25, 25, 20), ah = circle(25, 25, 10);
    const b = circle(75, 25, 20), bh = circle(75, 25, 10);
    // 父层必须取"最小的那个包含者"，否则第二个环会被错挂到第一个环的孔上
    check(
      "SVG 带孔 — 并排两个环各认各的孔",
      svgParser.extrudeShapesToMesh(polys(a, ah, b, bh), h, 0, 1),
      [90, h, 40],
      1,
      (area(a) - area(ah) + area(b) - area(bh)) * h,
    );
  }
}

console.log(failed === 0 ? "\n全部通过：导出的是水密封闭实体。" : `\n${failed} 项未通过。`);
process.exit(failed === 0 ? 0 : 1);
