"use client";

import { useState, useCallback, useRef, lazy, Suspense } from "react";
import PreviewPlaceholder from "./PreviewPlaceholder";
import { computeNormal, writeBinaryStl, downloadBlob, type Triangle } from "../lib/stl-utils";
import { parseSvgPath, extractPathsFromSvg, extrudePolygonToMesh } from "../lib/svg-parser";
import { exportToObj, exportToGlb } from "../lib/export-utils";

type ConversionMode = "heightmap" | "svg-extrude";
type Resolution = "low" | "medium" | "high" | "ultra";
type ExportFormat = "stl" | "obj" | "glb";

const RESOLUTION_MAP: Record<Resolution, number> = {
  low: 256,
  medium: 512,
  high: 1024,
  ultra: 2048,
};

const DECIMATION_MAP: Record<Resolution, number> = {
  low: 1,
  medium: 1,
  high: 0.6,
  ultra: 0.35,
};

interface ConversionParams {
  height: number;
  smoothness: number;
  baseHeight: number;
  invert: boolean;
  extrusionDepth: number;
  removeBg: boolean;
}

const SAMPLE_IMAGES = [
  {
    name: "Mona Lisa",
    url: "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20200%20200'%3E%3Crect%20width%3D'200'%20height%3D'200'%20fill%3D'%23f5e6d3'%2F%3E%3Cellipse%20cx%3D'100'%20cy%3D'85'%20rx%3D'40'%20ry%3D'50'%20fill%3D'%23d4a574'%2F%3E%3Cellipse%20cx%3D'100'%20cy%3D'65'%20rx%3D'35'%20ry%3D'30'%20fill%3D'%232c1810'%2F%3E%3Cellipse%20cx%3D'85'%20cy%3D'40'%20rx%3D'10'%20ry%3D'8'%20fill%3D'%232c1810'%2F%3E%3Cellipse%20cx%3D'115'%20cy%3D'40'%20rx%3D'10'%20ry%3D'8'%20fill%3D'%232c1810'%2F%3E%3Cpath%20d%3D'M85%20110%20Q100%20130%20115%20110'%20stroke%3D'%23884433'%20stroke-width%3D'3'%20fill%3D'none'%2F%3E%3Crect%20x%3D'60'%20y%3D'120'%20width%3D'80'%20height%3D'75'%20rx%3D'5'%20fill%3D'%232c1810'%2F%3E%3C%2Fsvg%3E",
    type: "heightmap",
  },
  {
    name: "Mountain Horizon",
    url: "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20300%20200'%3E%3Cdefs%3E%3ClinearGradient%20id%3D'sky'%20x1%3D'0%25'%20y1%3D'0%25'%20x2%3D'0%25'%20y2%3D'100%25'%3E%3Cstop%20offset%3D'0%25'%20style%3D'stop-color%3A%231a1a2e'%2F%3E%3Cstop%20offset%3D'60%25'%20style%3D'stop-color%3A%234a6fa5'%2F%3E%3Cstop%20offset%3D'100%25'%20style%3D'stop-color%3A%23f4a261'%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D'300'%20height%3D'200'%20fill%3D'url(%23sky)'%2F%3E%3Cpolygon%20points%3D'0%2C140%2060%2C60%2090%2C80%20130%2C40%20180%2C70%20220%2C30%20260%2C90%20300%2C50%20300%2C200%200%2C200'%20fill%3D'%232d4a3e'%2F%3E%3Cpolygon%20points%3D'0%2C160%2060%2C90%2090%2C105%20130%2C75%20180%2C95%20220%2C60%20260%2C110%20300%2C80%20300%2C200%200%2C200'%20fill%3D'%231a2e25'%2F%3E%3C%2Fsvg%3E",
    type: "heightmap",
  },
  {
    name: "Star Logo",
    url: "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20200%20200'%3E%3Crect%20width%3D'200'%20height%3D'200'%20fill%3D'%23ffffff'%2F%3E%3Cpolygon%20points%3D'100%2C10%20125%2C65%20185%2C65%20140%2C100%20155%2C155%20100%2C125%2045%2C155%2060%2C100%2015%2C65%2075%2C65'%20fill%3D'%23000000'%2F%3E%3C%2Fsvg%3E",
    type: "svg-extrude",
  },
  {
    name: "Gradient Sphere",
    url: "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20200%20200'%3E%3Cdefs%3E%3CradialGradient%20id%3D'g'%20cx%3D'50%25'%20cy%3D'45%25'%3E%3Cstop%20offset%3D'0%25'%20style%3D'stop-color%3A%23ffffff'%2F%3E%3Cstop%20offset%3D'60%25'%20style%3D'stop-color%3A%23888888'%2F%3E%3Cstop%20offset%3D'100%25'%20style%3D'stop-color%3A%23333333'%2F%3E%3C%2FradialGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D'200'%20height%3D'200'%20fill%3D'%23333'%2F%3E%3Ccircle%20cx%3D'100'%20cy%3D'100'%20r%3D'80'%20fill%3D'url(%23g)'%2F%3E%3C%2Fsvg%3E",
    type: "heightmap",
  },
];

function exportTriangles(triangles: Triangle[], name: string, format: ExportFormat) {
  if (format === "obj") {
    const objStr = exportToObj(triangles, name);
    const blob = new Blob([objStr], { type: "text/plain" });
    downloadBlob(blob, `${name}.obj`);
  } else if (format === "glb") {
    const blob = exportToGlb(triangles, name);
    downloadBlob(blob, `${name}.glb`);
  } else {
    const blob = writeBinaryStl(triangles, name);
    downloadBlob(blob, `${name}.stl`);
  }
}

export default function ConverterTool() {
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [svgTriangles, setSvgTriangles] = useState<Triangle[] | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [isDragging, setIsDragging] = useState(false);
  const [mode, setMode] = useState<ConversionMode>("heightmap");
  const [resolution, setResolution] = useState<Resolution>("medium");
  const [params, setParams] = useState<ConversionParams>({
    height: 0.8,
    smoothness: 0.3,
    baseHeight: 2,
    invert: false,
    extrusionDepth: 3,
    removeBg: false,
  });
  const [downloading, setDownloading] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("stl");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Define rasterizeSvg BEFORE processImage since processImage references it
  const rasterizeSvg = useCallback(
    (svgText: string) => {
      const maxDim = RESOLUTION_MAP[resolution];
      // Parse viewBox to get intrinsic dimensions
      const vbMatch = svgText.match(/viewBox=["']([^"']+)["']/);
      let vbW = maxDim;
      let vbH = maxDim;
      if (vbMatch) {
        const parts = vbMatch[1].split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          vbW = parts[2];
          vbH = parts[3];
        }
      }

      // Determine target dimensions
      let w = vbW;
      let h = vbH;
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.floor(w * ratio);
        h = Math.floor(h * ratio);
      }

      // Use DOMParser to validate and re-serialize SVG, then inject width/height
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, "image/svg+xml");
        const parseError = doc.querySelector("parsererror");
        if (parseError) {
          // SVG has XML errors — create synthetic heightmap
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d")!;
          const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
          grad.addColorStop(0, "#ccc");
          grad.addColorStop(1, "#333");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);
          setImageData(ctx.getImageData(0, 0, w, h));
          return;
        }

        const svgEl = doc.documentElement;
        svgEl.setAttribute("width", String(w));
        svgEl.setAttribute("height", String(h));

        const serializer = new XMLSerializer();
        const cleanSvg = serializer.serializeToString(doc);
        const base64 = btoa(unescape(encodeURIComponent(cleanSvg)));
        const dataUri = `data:image/svg+xml;base64,${base64}`;

        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0, w, h);
          const id = ctx.getImageData(0, 0, w, h);

          // Verify canvas is not blank
          let hasContent = false;
          for (let i = 0; i < Math.min(id.data.length, 400); i += 4) {
            if (id.data[i] > 5 || id.data[i + 1] > 5 || id.data[i + 2] > 5) {
              hasContent = true;
              break;
            }
          }

          if (!hasContent) {
            // SVG rendered blank — create synthetic heightmap from fill colors
            const fills: string[] = [];
            const fillRe = /fill=['"]#([0-9a-fA-F]{6})['"]/g;
            let fm;
            while ((fm = fillRe.exec(cleanSvg)) !== null) fills.push(`#${fm[1]}`);

            if (fills.length > 0) {
              const bandH = h / fills.length;
              fills.forEach((color, i) => {
                ctx.fillStyle = color;
                ctx.fillRect(0, i * bandH, w, bandH + 1);
              });
            } else {
              const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
              grad.addColorStop(0, "#ccc");
              grad.addColorStop(1, "#333");
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, w, h);
            }
          }
          setImageData(ctx.getImageData(0, 0, w, h));
        };
        img.onerror = () => {
          // Data URI failed — create synthetic heightmap
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d")!;
          const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
          grad.addColorStop(0, "#ccc");
          grad.addColorStop(1, "#333");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);
          setImageData(ctx.getImageData(0, 0, w, h));
        };
        img.src = dataUri;
      } catch (e) {
        // DOMParser threw — create synthetic heightmap
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        grad.addColorStop(0, "#ccc");
        grad.addColorStop(1, "#333");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        setImageData(ctx.getImageData(0, 0, w, h));
      }
    },
    [resolution],
  );

  const loadRaster = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxDim = RESOLUTION_MAP[resolution];
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
          setImageData(ctx.getImageData(0, 0, w, h));
        };
        img.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    },
    [resolution],
  );

  const processImage = useCallback(
    (file: File) => {
      setFileName(file.name);
      setSvgTriangles(null);

      // SVG files: try path extrusion, auto-detect mode
      if (file.type === "image/svg+xml") {
        const reader = new FileReader();
        reader.onload = (e) => {
          const svgText = e.target?.result as string;
          const paths = extractPathsFromSvg(svgText);
          if (paths.length === 0) {
            // No extractable paths: rasterize as heightmap
            setMode("heightmap");
            rasterizeSvg(svgText);
            return;
          }

          const allTriangles: Triangle[] = [];
          for (const pathData of paths) {
            const polygons = parseSvgPath(pathData);
            for (const poly of polygons) {
              if (poly.points.length < 3) continue;
              const tris = extrudePolygonToMesh(
                poly.points,
                params.extrusionDepth,
                0,
                1,
              );
              allTriangles.push(...tris);
            }
          }

          // Check if extruded geometry covers enough of the viewBox
          let useExtrude = allTriangles.length >= 4;
          if (useExtrude) {
            const vbMatch = svgText.match(/viewBox=["']([^"']+)["']/);
            if (vbMatch) {
              const vbParts = vbMatch[1].split(/[\s,]+/).map(Number);
              const vbArea = vbParts[2] * vbParts[3];
              let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
              for (const t of allTriangles) {
                for (const v of t.vertices) {
                  minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
                  minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
                }
              }
              const meshArea = (maxX - minX) * (maxZ - minZ);
              if (meshArea / vbArea < 0.05) useExtrude = false;
            }
          }

          if (useExtrude) {
            setSvgTriangles(allTriangles);
            setMode("svg-extrude");
          } else {
            setMode("heightmap");
            rasterizeSvg(svgText);
          }
        };
        reader.readAsText(file);
        return;
      }

      // Raster files: always heightmap mode
      setMode("heightmap");
      loadRaster(file);
    },
    [params.extrusionDepth, rasterizeSvg, loadRaster],
  );

  const loadSample = useCallback(
    (sample: (typeof SAMPLE_IMAGES)[0]) => {
      setFileName(sample.name);
      setSvgTriangles(null);
      setImageData(null); // Clear old data so ThreePreview doesn't render stale content

      const svgText = decodeURIComponent(sample.url.replace("data:image/svg+xml,", ""));

      // Always try path/polygon extrusion first
      const paths = extractPathsFromSvg(svgText);
      const allTriangles: Triangle[] = [];
      for (const pathData of paths) {
        const polygons = parseSvgPath(pathData);
        for (const poly of polygons) {
          if (poly.points.length < 3) continue;
          const tris = extrudePolygonToMesh(poly.points, params.extrusionDepth, 0, 1);
          allTriangles.push(...tris);
        }
      }

      // Check if extruded geometry covers enough of the viewBox
      let useExtrude = allTriangles.length >= 4;
      if (useExtrude) {
        const vbMatch = svgText.match(/viewBox=["']([^"']+)["']/);
        if (vbMatch) {
          const vbParts = vbMatch[1].split(/[\s,]+/).map(Number);
          const vbArea = vbParts[2] * vbParts[3];
          // Compute bounding box of extruded mesh (XZ plane, since Y is up)
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (const t of allTriangles) {
            for (const v of t.vertices) {
              minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
              minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
            }
          }
          const meshArea = (maxX - minX) * (maxZ - minZ);
          if (meshArea / vbArea < 0.05) useExtrude = false;
        }
      }

      if (useExtrude) {
        setSvgTriangles(allTriangles);
        setMode("svg-extrude");
      } else {
        // Not enough geometry or too small: fall back to heightmap
        setMode("heightmap");
        rasterizeSvg(svgText);
      }
    },
    [params.extrusionDepth, rasterizeSvg],
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

  const handleDownloadStl = useCallback(() => {
    setDownloading(true);
    try {
      // SVG extrusion mode
      if (svgTriangles) {
        const outputName = fileName.replace(/\.[^.]+$/, "");
        exportTriangles(svgTriangles, outputName, exportFormat);
        return;
      }

      if (!imageData) return;

      const w = imageData.width;
      const h = imageData.height;
      const pixels = imageData.data;
      const { height: hScale, smoothness, baseHeight, invert, removeBg } = params;

      // Build heightmap
      const heights: number[][] = Array.from({ length: h }, () => Array(w).fill(0));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          let gray = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3 / 255;

          // Background removal: if pixel is near-white and at edges, set to 0
          if (removeBg) {
            const isEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
            const alpha = pixels[idx + 3] / 255;
            if (alpha < 0.1 || (isEdge && gray > 0.9)) {
              gray = 0;
            }
          }

          heights[y][x] = (invert ? 1 - gray : gray) * hScale;
        }
      }

      // Smooth
      const sr = Math.floor(smoothness * 5);
      const copy = heights.map((row) => [...row]);
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
          heights[y][x] = sum / count + baseHeight * 0.1;
        }
      }

      // Decimate if needed
      const decimationRatio = DECIMATION_MAP[resolution];
      const step = decimationRatio < 1 ? Math.max(1, Math.round(1 / decimationRatio)) : 1;

      const dH = Math.ceil((h - 1) / step) + 1;
      const dW = Math.ceil((w - 1) / step) + 1;

      const wScale = 2.0 / dW;
      const hScale2 = 2.0 / dH;
      const triangles: Triangle[] = [];

      for (let y = 0; y < dH - 1; y++) {
        for (let x = 0; x < dW - 1; x++) {
          const sy = Math.min(y * step, h - 1);
          const sx = Math.min(x * step, w - 1);
          const sy2 = Math.min((y + 1) * step, h - 1);
          const sx2 = Math.min((x + 1) * step, w - 1);

          const x0 = (x - dW / 2) * wScale * step;
          const x1 = ((x + 1) - dW / 2) * wScale * step;
          const z0 = (y - dH / 2) * hScale2 * step;
          const z1 = ((y + 1) - dH / 2) * hScale2 * step;

          const v00: [number, number, number] = [x0, heights[sy][sx], z0];
          const v10: [number, number, number] = [x1, heights[sy][sx2], z0];
          const v01: [number, number, number] = [x0, heights[sy2][sx], z1];
          const v11: [number, number, number] = [x1, heights[sy2][sx2], z1];

          triangles.push({ normal: computeNormal(v00, v10, v11), vertices: [v00, v10, v11] });
          triangles.push({ normal: computeNormal(v00, v11, v01), vertices: [v00, v11, v01] });
        }
      }

      // Bottom plane
      const bY = baseHeight * 0.1 - 0.01;
      const halfX = (dW / 2) * wScale * step;
      const halfZ = (dH / 2) * hScale2 * step;
      const bl: [number, number, number] = [-halfX, bY, -halfZ];
      const br: [number, number, number] = [halfX, bY, -halfZ];
      const tl: [number, number, number] = [-halfX, bY, halfZ];
      const tr: [number, number, number] = [halfX, bY, halfZ];
      triangles.push({ normal: [0, -1, 0], vertices: [bl, tr, br] });
      triangles.push({ normal: [0, -1, 0], vertices: [bl, tl, tr] });

      const outputName = fileName.replace(/\.[^.]+$/, "");
      exportTriangles(triangles, outputName, exportFormat);
    } finally {
      setDownloading(false);
    }
  }, [imageData, svgTriangles, fileName, params, resolution, exportFormat]);

  const hasPreviewData = !!(imageData || svgTriangles);
  const triangleCount = svgTriangles
    ? svgTriangles.length
    : imageData
      ? Math.round(((imageData.width - 1) * (imageData.height - 1) * 2) / (DECIMATION_MAP[resolution] < 1 ? DECIMATION_MAP[resolution] : 1))
      : 0;

  return (
    <div>
      {/* Mode & Resolution Selector */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center rounded-tool bg-surface-100 dark:bg-surface-800 p-1">
          <button
            onClick={() => { setMode("heightmap"); setSvgTriangles(null); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              mode === "heightmap"
                ? "bg-surface-50 dark:bg-surface-700 text-surface-900 dark:text-surface-100 shadow-sm"
                : "text-surface-500 hover:text-surface-700 dark:hover:text-surface-300"
            }`}
          >
            Heightmap
          </button>
          <button
            onClick={() => { setMode("svg-extrude"); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              mode === "svg-extrude"
                ? "bg-surface-50 dark:bg-surface-700 text-surface-900 dark:text-surface-100 shadow-sm"
                : "text-surface-500 hover:text-surface-700 dark:hover:text-surface-300"
            }`}
          >
            SVG Extrude
          </button>
        </div>

        {mode === "heightmap" && (
          <div className="flex items-center rounded-tool bg-surface-100 dark:bg-surface-800 p-1">
            {(["low", "medium", "high", "ultra"] as Resolution[]).map((r) => (
              <button
                key={r}
                onClick={() => setResolution(r)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  resolution === r
                    ? "bg-surface-50 dark:bg-surface-700 text-surface-900 dark:text-surface-100 shadow-sm"
                    : "text-surface-500 hover:text-surface-700 dark:hover:text-surface-300"
                }`}
              >
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </button>
            ))}
          </div>
        )}

        <button
          onClick={() => setShowSamples(!showSamples)}
          className="px-3 py-1.5 rounded-tool text-xs font-medium bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:text-surface-900 dark:hover:text-surface-100 transition-colors"
        >
          {showSamples ? "Hide Samples" : "Try Samples"}
        </button>

        {hasPreviewData && (
          <span className="text-2xs text-surface-400 font-mono">
            ~{triangleCount.toLocaleString()} triangles
          </span>
        )}
      </div>

      {/* Sample images */}
      {showSamples && (
        <div className="mb-4 p-4 rounded-tool border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900/50">
          <p className="text-xs text-surface-500 mb-3">Click a sample to see instant results:</p>
          <div className="flex flex-wrap gap-2">
            {SAMPLE_IMAGES.map((sample) => (
              <button
                key={sample.name}
                onClick={() => loadSample(sample)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-200 dark:bg-surface-800 text-surface-700 dark:text-surface-300 hover:bg-accent-100 hover:text-accent-700 dark:hover:bg-accent-900/30 dark:hover:text-accent-400 transition-colors"
              >
                {sample.name}
                <span className="ml-1.5 text-2xs text-surface-400">
                  ({sample.type === "svg-extrude" ? "SVG" : "Heightmap"})
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

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
                  Drop your image here
                </p>
                <p className="text-2xs text-surface-400">{mode === "svg-extrude" ? "SVG vector graphics (path extrusion)" : "JPG, PNG, SVG, BMP, WebP"}</p>
              </div>
            )}
          </div>

          {/* Parameters */}
          {mode === "heightmap" && (
            <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-5">
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Parameters</h3>
              <ParamSlider
                label="Height"
                value={params.height}
                min={0.1}
                max={3}
                step={0.05}
                onChange={(v: number) => setParams((p) => ({ ...p, height: v }))}
              />
              <ParamSlider
                label="Smoothness"
                value={params.smoothness}
                min={0}
                max={1}
                step={0.05}
                onChange={(v: number) => setParams((p) => ({ ...p, smoothness: v }))}
              />
              <ParamSlider
                label="Base Thickness"
                value={params.baseHeight}
                min={0}
                max={10}
                step={0.5}
                onChange={(v: number) => setParams((p) => ({ ...p, baseHeight: v }))}
              />
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={params.invert}
                  onChange={(e) => setParams((p) => ({ ...p, invert: e.target.checked }))}
                  className="w-4 h-4 rounded border-surface-300 dark:border-surface-700 text-accent-600 focus:ring-accent-500"
                />
                <span className="text-sm text-surface-600 dark:text-surface-400">Invert (dark areas rise)</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={params.removeBg}
                  onChange={(e) => setParams((p) => ({ ...p, removeBg: e.target.checked }))}
                  className="w-4 h-4 rounded border-surface-300 dark:border-surface-700 text-accent-600 focus:ring-accent-500"
                />
                <span className="text-sm text-surface-600 dark:text-surface-400">Remove background</span>
              </label>
            </div>
          )}

          {mode === "svg-extrude" && (
            <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-5">
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Extrusion Settings</h3>
              <ParamSlider
                label="Extrusion Depth"
                value={params.extrusionDepth}
                min={0.5}
                max={10}
                step={0.5}
                onChange={(v: number) => setParams((p) => ({ ...p, extrusionDepth: v }))}
              />
              <div className="p-3 rounded-lg bg-surface-100 dark:bg-surface-800/50">
                <p className="text-2xs text-surface-500 leading-relaxed">
                  <strong className="text-surface-700 dark:text-surface-300">SVG Extrusion:</strong>{" "}
                  Parses actual vector paths from your SVG, triangulates closed shapes, and extrudes them into
                  solid 3D geometry. Best for logos, icons, and text shapes. Auto-detects SVG format.
                </p>
              </div>
            </div>
          )}

          {/* Export format */}
          <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-3">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Export Format</h3>
            <div className="flex gap-2">
              {(["stl", "obj", "glb"] as ExportFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setExportFormat(fmt)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
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
              {exportFormat === "stl" && "STL — Universal 3D printing format. Works with all slicers."}
              {exportFormat === "obj" && "OBJ — Wavefront format. Supports color in Blender, etc."}
              {exportFormat === "glb" && "GLB — Modern glTF binary. Best for web and AR/VR."}
            </p>
          </div>

          {/* Download */}
          <button
            onClick={handleDownloadStl}
            disabled={!hasPreviewData || downloading}
            className={`w-full py-2.5 rounded-tool text-sm font-medium transition-all ${
              hasPreviewData
                ? "bg-accent-600 text-white hover:bg-accent-700 active:scale-[0.98]"
                : "bg-surface-200 dark:bg-surface-800 text-surface-400 cursor-not-allowed"
            }`}
          >
            {downloading ? "Generating..." : `Download ${exportFormat.toUpperCase()}`}
          </button>
        </div>

        {/* 3D Preview */}
        <Suspense fallback={<PreviewPlaceholder />}>
          <ThreePreview
            imageData={imageData}
            params={params}
            svgTriangles={svgTriangles}
            mode={mode}
          />
        </Suspense>
      </div>
    </div>
  );
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
        <span className="text-xs font-mono text-surface-400">{value.toFixed(2)}</span>
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
