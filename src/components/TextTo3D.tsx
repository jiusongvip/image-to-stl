"use client";

import { useState, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import PreviewPlaceholder from "./PreviewPlaceholder";
import { computeNormal, writeBinaryStl, downloadBlob, type Triangle } from "../lib/stl-utils";
import { exportToObj } from "../lib/export-utils";

type ExportFormat = "stl" | "obj";

interface TextParams {
  text: string;
  fontSize: number;
  fontWeight: string;
  extrusionDepth: number;
  baseThickness: number;
  bevelSize: number;
  canvasWidth: number;
  canvasHeight: number;
}

const FONT_WEIGHTS = ["400", "500", "600", "700", "900"];

export default function TextTo3D() {
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("stl");
  const [params, setParams] = useState<TextParams>({
    text: "Hello",
    fontSize: 120,
    fontWeight: "700",
    extrusionDepth: 3,
    baseThickness: 1,
    bevelSize: 0.3,
    canvasWidth: 512,
    canvasHeight: 256,
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Render text to canvas and extract image data
  const renderText = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = params.canvasWidth;
    canvas.height = params.canvasHeight;
    const ctx = canvas.getContext("2d")!;

    // Clear with transparent black
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw text in white
    ctx.fillStyle = "#ffffff";
    ctx.font = `${params.fontWeight} ${params.fontSize}px "Arial", "Helvetica", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(params.text || " ", canvas.width / 2, canvas.height / 2);

    // Extract image data
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setImageData(data);

    // Draw preview on the small preview canvas
    if (previewCanvasRef.current) {
      const pCtx = previewCanvasRef.current.getContext("2d")!;
      previewCanvasRef.current.width = canvas.width;
      previewCanvasRef.current.height = canvas.height;
      pCtx.putImageData(data, 0, 0);
    }
  }, [params]);

  // Auto-render on mount and when params change (with debounce)
  useEffect(() => {
    const timer = setTimeout(renderText, 150);
    return () => clearTimeout(timer);
  }, [renderText]);

  const handleDownload = useCallback(() => {
    if (!imageData) return;
    setDownloading(true);
    try {
      const triangles = buildTextMesh(imageData, params);
      const name = (params.text || "text").replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30);

      if (exportFormat === "obj") {
        const objStr = exportToObj(triangles, name);
        const blob = new Blob([objStr], { type: "text/plain" });
        downloadBlob(blob, `${name}.obj`);
      } else {
        const blob = writeBinaryStl(triangles, name);
        downloadBlob(blob, `${name}.stl`);
      }
    } finally {
      setDownloading(false);
    }
  }, [imageData, params, exportFormat]);

  const previewParams = {
    height: params.extrusionDepth / 5,
    smoothness: 0.1,
    baseHeight: params.baseThickness,
    invert: false,
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="flex flex-col gap-4">
        {/* Text input */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Text Input</h3>
          <div>
            <label className="text-xs font-medium text-surface-500 mb-1 block">Your Text</label>
            <input
              type="text"
              value={params.text}
              onChange={(e) => setParams((p) => ({ ...p, text: e.target.value }))}
              placeholder="Enter text..."
              className="w-full px-3 py-2 rounded-lg bg-surface-100 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 text-surface-900 dark:text-surface-100 text-sm focus:ring-2 focus:ring-accent-500 focus:border-transparent outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-surface-500 mb-1 block">Font Size</label>
              <input
                type="range"
                min={24}
                max={200}
                step={4}
                value={params.fontSize}
                onChange={(e) => setParams((p) => ({ ...p, fontSize: parseFloat(e.target.value) }))}
                className="w-full h-1.5 rounded-full appearance-none bg-surface-200 dark:bg-surface-800 accent-accent-500 cursor-pointer"
              />
              <span className="text-2xs font-mono text-surface-400">{params.fontSize}px</span>
            </div>
            <div>
              <label className="text-xs font-medium text-surface-500 mb-1 block">Weight</label>
              <div className="flex gap-1">
                {FONT_WEIGHTS.map((w) => (
                  <button
                    key={w}
                    onClick={() => setParams((p) => ({ ...p, fontWeight: w }))}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      params.fontWeight === w
                        ? "bg-accent-600 text-white"
                        : "bg-surface-100 dark:bg-surface-800 text-surface-500 hover:text-surface-700 dark:hover:text-surface-300"
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 3D Settings */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">3D Settings</h3>
          <ParamSlider
            label="Extrusion Depth"
            value={params.extrusionDepth}
            min={0.5}
            max={10}
            step={0.5}
            onChange={(v: number) => setParams((p) => ({ ...p, extrusionDepth: v }))}
          />
          <ParamSlider
            label="Base Thickness"
            value={params.baseThickness}
            min={0}
            max={5}
            step={0.5}
            onChange={(v: number) => setParams((p) => ({ ...p, baseThickness: v }))}
          />
          <ParamSlider
            label="Bevel / Smoothness"
            value={params.bevelSize}
            min={0}
            max={2}
            step={0.1}
            onChange={(v: number) => setParams((p) => ({ ...p, bevelSize: v }))}
          />
        </div>

        {/* Export format */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Export Format</h3>
          <div className="flex gap-2">
            {(["stl", "obj"] as ExportFormat[]).map((fmt) => (
              <button
                key={fmt}
                onClick={() => setExportFormat(fmt)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                  exportFormat === fmt
                    ? "bg-accent-600 text-white"
                    : "bg-surface-100 dark:bg-surface-800 text-surface-500 hover:text-surface-700 dark:hover:text-surface-300"
                }`}
              >
                {fmt.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="text-2xs text-surface-400">
            {exportFormat === "stl"
              ? "STL — Universal 3D printing format. Works with all slicers."
              : "OBJ — Wavefront format. Supports color materials in Blender, etc."}
          </p>
        </div>

        {/* Download */}
        <button
          onClick={handleDownload}
          disabled={!imageData || downloading}
          className={`w-full py-2.5 rounded-tool text-sm font-medium transition-all ${
            imageData
              ? "bg-accent-600 text-white hover:bg-accent-700 active:scale-[0.98]"
              : "bg-surface-200 dark:bg-surface-800 text-surface-400 cursor-not-allowed"
          }`}
        >
          {downloading ? "Generating..." : `Download ${exportFormat.toUpperCase()}`}
        </button>
      </div>

      {/* Preview */}
      <div className="flex flex-col gap-4">
        {/* Text preview */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 overflow-hidden bg-surface-900 p-4">
          <p className="text-2xs text-surface-400 mb-2">Text Preview (what will be extruded)</p>
          <canvas
            ref={canvasRef}
            className="hidden"
          />
          <canvas
            ref={previewCanvasRef}
            className="w-full rounded-lg"
            style={{ imageRendering: "auto" }}
          />
        </div>

        {/* 3D Preview */}
        <div className="min-h-[350px] lg:min-h-[450px]">
            <Suspense fallback={<PreviewPlaceholder />}>
              <ThreePreview imageData={imageData} params={previewParams} />
            </Suspense>
        </div>

        <div className="p-3 rounded-lg bg-surface-100 dark:bg-surface-800/50">
          <p className="text-2xs text-surface-500 leading-relaxed">
            <strong className="text-surface-700 dark:text-surface-300">How it works:</strong>{" "}
            Text is rendered to a canvas, then converted to a heightmap. White areas become raised,
            black areas stay at base level. Use bold fonts and short text for best 3D results.
            For cleaner vector edges, try the{" "}
            <a href="/svg-to-stl/" className="text-accent-600 dark:text-accent-400 hover:underline">SVG to STL converter</a>{" "}
            with text converted to paths.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Build a 3D mesh from text-rendered image data.
 * Uses heightmap approach: white text → raised, black background → base.
 */
function buildTextMesh(imageData: ImageData, params: TextParams): Triangle[] {
  const { width: w, height: h, data: pixels } = imageData;
  const { extrusionDepth, baseThickness, bevelSize } = params;

  const triangles: Triangle[] = [];
  const heights: number[][] = Array.from({ length: h }, () => Array(w).fill(0));

  // Extract heightmap from alpha/luminance
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const gray = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3 / 255;
      heights[y][x] = gray * extrusionDepth;
    }
  }

  // Apply bevel (simple box blur on height)
  if (bevelSize > 0) {
    const r = Math.max(1, Math.floor(bevelSize * 3));
    const copy = heights.map((row) => [...row]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = copy[y][x];
        let count = 1;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
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

  // Decimate: skip pixels for performance
  const step = Math.max(1, Math.round(Math.max(w, h) / 256));

  const scaleX = 2.0 / Math.ceil(w / step);
  const scaleZ = 2.0 / Math.ceil(h / step);

  // Top surface
  for (let y = 0; y < h - step; y += step) {
    for (let x = 0; x < w - step; x += step) {
      const x0 = (x - w / 2) * scaleX;
      const x1 = (x + step - w / 2) * scaleX;
      const z0 = (y - h / 2) * scaleZ;
      const z1 = (y + step - h / 2) * scaleZ;

      const v00: [number, number, number] = [x0, heights[y][x] + baseThickness * 0.1, z0];
      const v10: [number, number, number] = [x1, heights[y][Math.min(x + step, w - 1)] + baseThickness * 0.1, z0];
      const v01: [number, number, number] = [x0, heights[Math.min(y + step, h - 1)][x] + baseThickness * 0.1, z1];
      const v11: [number, number, number] = [x1, heights[Math.min(y + step, h - 1)][Math.min(x + step, w - 1)] + baseThickness * 0.1, z1];

      triangles.push({ normal: computeNormal(v00, v10, v11), vertices: [v00, v10, v11] });
      triangles.push({ normal: computeNormal(v00, v11, v01), vertices: [v00, v11, v01] });
    }
  }

  // Bottom plane
  const bY = 0;
  const halfX = (w / 2) * scaleX;
  const halfZ = (h / 2) * scaleZ;
  const bl: [number, number, number] = [-halfX, bY, -halfZ];
  const br: [number, number, number] = [halfX, bY, -halfZ];
  const tl: [number, number, number] = [-halfX, bY, halfZ];
  const tr: [number, number, number] = [halfX, bY, halfZ];
  triangles.push({ normal: [0, -1, 0], vertices: [bl, tr, br] });
  triangles.push({ normal: [0, -1, 0], vertices: [bl, tl, tr] });

  // Side walls
  const wallH = extrusionDepth + baseThickness * 0.1;
  // Front wall (z = -halfZ)
  triangles.push(
    { normal: [0, 0, -1], vertices: [[-halfX, bY, -halfZ], [-halfX, wallH, -halfZ], [halfX, wallH, -halfZ]] },
    { normal: [0, 0, -1], vertices: [[-halfX, bY, -halfZ], [halfX, wallH, -halfZ], [halfX, bY, -halfZ]] },
  );
  // Back wall (z = halfZ)
  triangles.push(
    { normal: [0, 0, 1], vertices: [[halfX, bY, halfZ], [halfX, wallH, halfZ], [-halfX, wallH, halfZ]] },
    { normal: [0, 0, 1], vertices: [[halfX, bY, halfZ], [-halfX, wallH, halfZ], [-halfX, bY, halfZ]] },
  );
  // Left wall (x = -halfX)
  triangles.push(
    { normal: [-1, 0, 0], vertices: [[-halfX, bY, halfZ], [-halfX, wallH, halfZ], [-halfX, wallH, -halfZ]] },
    { normal: [-1, 0, 0], vertices: [[-halfX, bY, halfZ], [-halfX, wallH, -halfZ], [-halfX, bY, -halfZ]] },
  );
  // Right wall (x = halfX)
  triangles.push(
    { normal: [1, 0, 0], vertices: [[halfX, bY, -halfZ], [halfX, wallH, -halfZ], [halfX, wallH, halfZ]] },
    { normal: [1, 0, 0], vertices: [[halfX, bY, -halfZ], [halfX, wallH, halfZ], [halfX, bY, halfZ]] },
  );

  return triangles;
}

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-surface-500">{label}</label>
        <span className="text-xs font-mono text-surface-400">{value.toFixed(1)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none bg-surface-200 dark:bg-surface-800 accent-accent-500 cursor-pointer"
      />
    </div>
  );
}
const ThreePreview = lazy(() => import("./ThreePreview"));
