"use client";

import { useState, useCallback, useRef, useId, useMemo, lazy, Suspense } from "react";
import PreviewPlaceholder from "./PreviewPlaceholder";
import { writeBinaryStl, downloadBlob, type Triangle } from "../lib/stl-utils";
import { exportToObj } from "../lib/export-utils";
import { buildCookieCutterMesh } from "../lib/cutter";

type ExportFormat = "stl" | "obj";

interface CutterParams {
  wallHeight: number;
  wallThickness: number;
  threshold: number;
  smoothing: number;
  simplifyTolerance: number;
}

export default function CookieCutter() {
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [contour, setContour] = useState<[number, number][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("stl");
  const [params, setParams] = useState<CutterParams>({
    wallHeight: 25,
    wallThickness: 1.5,
    threshold: 128,
    smoothing: 3,
    simplifyTolerance: 1.5,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  const processImage = useCallback(
    (file: File) => {
      setFileName(file.name);
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 400;
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            const ratio = Math.min(maxDim / w, maxDim / h);
            w = Math.floor(w * ratio);
            h = Math.floor(h * ratio);
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h);
          setImageData(data);

          // Extract contour
          const binary = thresholdImage(data, params.threshold);
          const smoothed = smoothBinary(binary, w, h, params.smoothing);
          const contourPts = traceContour(smoothed, w, h);
          const simplified = simplifyContour(contourPts, params.simplifyTolerance);
          setContour(simplified);

          // Draw preview
          if (previewCanvasRef.current) {
            previewCanvasRef.current.width = w;
            previewCanvasRef.current.height = h;
            const pCtx = previewCanvasRef.current.getContext("2d")!;
            pCtx.putImageData(data, 0, 0);
            // Draw contour overlay
            if (simplified.length > 2) {
              pCtx.strokeStyle = "#3b82f6";
              pCtx.lineWidth = 2;
              pCtx.beginPath();
              pCtx.moveTo(simplified[0][0], simplified[0][1]);
              for (let i = 1; i < simplified.length; i++) {
                pCtx.lineTo(simplified[i][0], simplified[i][1]);
              }
              pCtx.closePath();
              pCtx.stroke();
            }
          }
        };
        img.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    },
    [params.threshold, params.smoothing, params.simplifyTolerance],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) processImage(file);
    },
    [processImage],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processImage(file);
    },
    [processImage],
  );

  const handleDownload = useCallback(() => {
    if (!contour || contour.length < 3) return;
    setDownloading(true);
    try {
      const triangles = buildCookieCutterMesh(contour, params);
      const name = fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30) || "cookie-cutter";

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
  }, [contour, params, exportFormat, fileName]);

  // 预览直接渲染导出用的那一份网格，拖动滑块时看到的就是切片器会看到的。
  const previewTriangles = useMemo(
    () => (contour && contour.length >= 3 ? buildCookieCutterMesh(contour, params) : null),
    [contour, params],
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="flex flex-col gap-4">
        {/* Drop zone */}
        <div
          className={`relative rounded-tool border-2 border-dashed transition-colors p-8 text-center cursor-pointer ${
            isDragging
              ? "border-accent-500 bg-accent-50 dark:bg-accent-950/20"
              : "border-surface-300 dark:border-surface-700 hover:border-surface-400 dark:hover:border-surface-600"
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/svg+xml,image/bmp,image/webp"
            onChange={handleFileSelect}
            className="hidden"
          />
          {fileName ? (
            <div className="space-y-1">
              <div className="w-10 h-10 mx-auto rounded-lg bg-accent-100 dark:bg-accent-900/30 flex items-center justify-center">
                <svg className="w-5 h-5 text-accent-600 dark:text-accent-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </div>
              <p className="text-sm font-medium text-surface-700 dark:text-surface-300 truncate max-w-[200px] mx-auto">
                {fileName}
              </p>
              <p className="text-2xs text-surface-400">Click or drop to replace</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="w-12 h-12 mx-auto rounded-xl bg-surface-200 dark:bg-surface-800 flex items-center justify-center">
                <svg className="w-6 h-6 text-surface-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <p className="text-sm font-medium text-surface-600 dark:text-surface-400">
                Drop an image to create a cookie cutter
              </p>
              <p className="text-2xs text-surface-400">Best with high-contrast images, logos, or silhouettes</p>
            </div>
          )}
        </div>

        {/* Contour preview */}
        {imageData && (
          <div className="rounded-tool border border-surface-200 dark:border-surface-800 overflow-hidden bg-white">
            <canvas ref={previewCanvasRef} className="w-full" />
          </div>
        )}

        {/* Image settings */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Image Settings</h3>
          <ParamSlider
            label="Threshold"
            value={params.threshold}
            min={10}
            max={245}
            step={5}
            onChange={(v: number) => setParams((p) => ({ ...p, threshold: v }))}
          />
          <ParamSlider
            label="Edge Smoothing"
            value={params.smoothing}
            min={0}
            max={10}
            step={1}
            onChange={(v: number) => setParams((p) => ({ ...p, smoothing: v }))}
          />
          <ParamSlider
            label="Contour Simplify"
            value={params.simplifyTolerance}
            min={0.5}
            max={5}
            step={0.5}
            onChange={(v: number) => setParams((p) => ({ ...p, simplifyTolerance: v }))}
          />
        </div>

        {/* Cutter dimensions */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Cutter Dimensions (mm)</h3>
          <ParamSlider
            label="Wall Height"
            value={params.wallHeight}
            min={10}
            max={50}
            step={1}
            onChange={(v: number) => setParams((p) => ({ ...p, wallHeight: v }))}
          />
          <ParamSlider
            label="Wall Thickness"
            value={params.wallThickness}
            min={0.5}
            max={4}
            step={0.5}
            onChange={(v: number) => setParams((p) => ({ ...p, wallThickness: v }))}
          />
        </div>

        {/* Export format */}
        <div className="flex gap-2">
          {(["stl", "obj"] as ExportFormat[]).map((fmt) => (
            <button
              key={fmt}
              onClick={() => setExportFormat(fmt)}
              className={`flex-1 py-2 rounded-tool text-sm font-medium transition-colors ${
                exportFormat === fmt
                  ? "bg-accent-600 text-white"
                  : "bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:text-surface-800 dark:hover:text-surface-300"
              }`}
            >
              {fmt.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Download */}
        <button
          onClick={handleDownload}
          disabled={!contour || contour.length < 3 || downloading}
          className={`w-full py-2.5 rounded-tool text-sm font-medium transition-all ${
            contour && contour.length >= 3
              ? "bg-accent-600 text-white hover:bg-accent-700 active:scale-[0.98]"
              : "bg-surface-200 dark:bg-surface-800 text-surface-400 cursor-not-allowed"
          }`}
        >
          {downloading ? "Generating..." : `Download ${exportFormat.toUpperCase()} Cookie Cutter`}
        </button>
      </div>

      {/* 3D Preview */}
      <div className="flex flex-col gap-4">
        <div className="min-h-[400px] lg:min-h-[600px]">
            <Suspense fallback={<PreviewPlaceholder />}>
              <ThreePreview imageData={null} params={{}} svgTriangles={previewTriangles} mode="svg-extrude" />
            </Suspense>
        </div>
        <div className="p-3 rounded-lg bg-surface-100 dark:bg-surface-800/50">
          <p className="text-2xs text-surface-500 leading-relaxed">
            <strong className="text-surface-700 dark:text-surface-300">Tips:</strong>{" "}
            Use high-contrast images for best results. Black-and-white silhouettes work perfectly.
            Adjust <strong>Threshold</strong> to control what becomes the cutting edge.
            Lower <strong>Simplify</strong> for more detail, higher for smoother curves.
            Print with food-safe PLA and press with the cutter square to the dough so the wall cuts cleanly.
          </p>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Image Processing Utilities
// ────────────────────────────────────────────────────────────

function thresholdImage(data: ImageData, threshold: number): Uint8Array {
  const w = data.width;
  const h = data.height;
  const binary = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    const gray = (data.data[idx] + data.data[idx + 1] + data.data[idx + 2]) / 3;
    binary[i] = gray < threshold ? 1 : 0; // dark = foreground
  }
  return binary;
}

function smoothBinary(binary: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return binary;
  const result = new Uint8Array(w * h);
  const r = Math.floor(radius);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            sum += binary[ny * w + nx];
            count++;
          }
        }
      }
      result[y * w + x] = sum / count > 0.5 ? 1 : 0;
    }
  }
  return result;
}

/**
 * Trace the outer contour of a binary image using Moore neighborhood tracing.
 * Returns array of [x, y] points.
 */
function traceContour(binary: Uint8Array, w: number, h: number): [number, number][] {
  // 8-connected neighbor offsets (clockwise from East)
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  // Find starting edge pixel (topmost-leftmost foreground)
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (binary[y * w + x] === 1) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }

  if (startX < 0) return [];

  const chain: [number, number][] = [[startX, startY]];
  let cx = startX;
  let cy = startY;
  let dir = 0; // Start searching East
  const maxSteps = w * h; // Safety limit

  for (let step = 0; step < maxSteps; step++) {
    let found = false;
    // Search in 8 directions starting from (dir+6)%8 (backtrack direction - 1)
    const startDir = (dir + 6) % 8;

    for (let i = 0; i < 8; i++) {
      const d = (startDir + i) % 8;
      const nx = cx + dx[d];
      const ny = cy + dy[d];

      if (nx >= 0 && nx < w && ny >= 0 && ny < h && binary[ny * w + nx] === 1) {
        dir = d;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }

    if (!found) break;
    if (cx === startX && cy === startY) break; // Closed contour
    chain.push([cx, cy]);
  }

  return chain;
}

/**
 * Douglas-Peucker contour simplification.
 */
function simplifyContour(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 3) return points;

  // Find the point with maximum distance from the line between first and last
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    // Recursively simplify both halves
    const left = simplifyContour(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyContour(points.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function perpendicularDistance(
  point: [number, number],
  lineStart: [number, number],
  lineEnd: [number, number],
): number {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);

  const t = Math.max(0, Math.min(1, ((point[0] - lineStart[0]) * dx + (point[1] - lineStart[1]) * dy) / lenSq));
  const projX = lineStart[0] + t * dx;
  const projY = lineStart[1] + t * dy;
  return Math.hypot(point[0] - projX, point[1] - projY);
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
  const sliderId = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={sliderId} className="text-xs font-medium text-surface-500 dark:text-surface-400">{label}</label>
        <span className="text-xs font-mono text-surface-400">{Number.isInteger(step) ? value : value.toFixed(1)}</span>
      </div>
      <input
        id={sliderId}
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
