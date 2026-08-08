"use client";

import { useState, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import { computeNormal, writeBinaryStl, downloadBlob, type Triangle } from "../lib/stl-utils";
import PreviewPlaceholder from "./PreviewPlaceholder";

interface EditorParams {
  height: number;
  smoothness: number;
  baseHeight: number;
  invert: boolean;
  contrast: number;
  brightness: number;
  threshold: number;
  thresholdEnabled: boolean;
}

export default function HeightmapEditor() {
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [processedData, setProcessedData] = useState<ImageData | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [isDragging, setIsDragging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  
  const [params, setParams] = useState<EditorParams>({
    height: 0.8,
    smoothness: 0.3,
    baseHeight: 2,
    invert: false,
    contrast: 65,
    brightness: 55,
    threshold: 128,
    thresholdEnabled: false,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Process original image through contrast/brightness/threshold
  useEffect(() => {
    if (!imageData) {
      setProcessedData(null);
      return;
    }

    // Use offscreen canvas for image processing (no DOM needed)
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d")!;

    // Copy original data
    const srcData = imageData.data;
    const dstData = ctx.createImageData(imageData.width, imageData.height);
    const contrast = params.contrast / 50; // 0-2
    const brightness = (params.brightness - 50) / 50; // -1 to 1

    for (let i = 0; i < srcData.length; i += 4) {
      let r = srcData[i];
      let g = srcData[i + 1];
      let b = srcData[i + 2];

      // Apply contrast and brightness
      r = Math.min(255, Math.max(0, (r - 128) * contrast + 128 + brightness * 128));
      g = Math.min(255, Math.max(0, (g - 128) * contrast + 128 + brightness * 128));
      b = Math.min(255, Math.max(0, (b - 128) * contrast + 128 + brightness * 128));

      // Apply threshold as binary cut
      if (params.thresholdEnabled) {
        const gray = (r + g + b) / 3;
        const val = gray > params.threshold ? 255 : 0;
        r = val; g = val; b = val;
      }

      // Apply invert for real-time preview
      if (params.invert) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }

      // Apply height scale visually (brighter = taller)
      const hScale = Math.max(0.2, Math.min(2.0, params.height / 0.8));
      r = Math.min(255, Math.max(0, 128 + (r - 128) * hScale));
      g = Math.min(255, Math.max(0, 128 + (g - 128) * hScale));
      b = Math.min(255, Math.max(0, 128 + (b - 128) * hScale));

      dstData.data[i] = r;
      dstData.data[i + 1] = g;
      dstData.data[i + 2] = b;
      dstData.data[i + 3] = 255;
    }



    ctx.putImageData(dstData, 0, 0);
    setProcessedData(dstData);
  }, [imageData, params]);


  const processImage = useCallback((file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 512;
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
  }, []);

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
    if (!processedData) return;
    setDownloading(true);
    try {
      const w = processedData.width;
      const h = processedData.height;
      const { height: hScale, smoothness, baseHeight, invert } = params;

      const pixels = processedData.data;
      const heights: number[][] = Array.from({ length: h }, () => Array(w).fill(0));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const gray = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3 / 255;
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

      const wScale = 2.0 / w;
      const hScale2 = 2.0 / h;
      const triangles: Triangle[] = [];

      for (let y = 0; y < h - 1; y++) {
        for (let x = 0; x < w - 1; x++) {
          const x0 = (x - w / 2) * wScale;
          const x1 = ((x + 1) - w / 2) * wScale;
          const z0 = (y - h / 2) * hScale2;
          const z1 = ((y + 1) - h / 2) * hScale2;

          const v00: [number, number, number] = [x0, heights[y][x], z0];
          const v10: [number, number, number] = [x1, heights[y][x + 1], z0];
          const v01: [number, number, number] = [x0, heights[y + 1][x], z1];
          const v11: [number, number, number] = [x1, heights[y + 1][x + 1], z1];

          triangles.push({ normal: computeNormal(v00, v10, v11), vertices: [v00, v10, v11] });
          triangles.push({ normal: computeNormal(v00, v11, v01), vertices: [v00, v11, v01] });
        }
      }

      // Bottom plane
      const bY = baseHeight * 0.1 - 0.01;
      const bl: [number, number, number] = [-1, bY, -1];
      const br: [number, number, number] = [1, bY, -1];
      const tl: [number, number, number] = [-1, bY, 1];
      const tr: [number, number, number] = [1, bY, 1];
      triangles.push({ normal: [0, -1, 0], vertices: [bl, tr, br] });
      triangles.push({ normal: [0, -1, 0], vertices: [bl, tl, tr] });

      const blob = writeBinaryStl(triangles, fileName);
      downloadBlob(blob, fileName.replace(/\.[^.]+$/, "") + ".stl");
    } finally {
      setDownloading(false);
    }
  }, [processedData, params, fileName]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="flex flex-col gap-4">
        {/* Drop zone */}
        <div
          className={`relative rounded-tool border-2 border-dashed transition-colors p-6 text-center cursor-pointer ${
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
            accept="image/jpeg,image/png,image/bmp,image/webp"
            onChange={handleFileSelect}
            className="hidden"
          />
          {fileName ? (
            <div className="space-y-1">
              <p className="text-sm font-medium text-surface-700 dark:text-surface-300 truncate max-w-[200px] mx-auto">{fileName}</p>
              <p className="text-2xs text-surface-400">Click or drop to replace</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-surface-600 dark:text-surface-400">Drop image for heightmap editing</p>
              <p className="text-2xs text-surface-400">JPG, PNG, BMP, WebP</p>
            </div>
          )}
        </div>

        {/* Image adjustments */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Image Adjustments</h3>

          <ParamSlider
            label="Contrast"
            value={params.contrast}
            min={1}
            max={100}
            step={1}
            onChange={(v: number) => setParams((p) => ({ ...p, contrast: v }))}
          />
          <ParamSlider
            label="Brightness"
            value={params.brightness}
            min={0}
            max={100}
            step={1}
            onChange={(v: number) => setParams((p) => ({ ...p, brightness: v }))}
          />

          <div className="border-t border-surface-200 dark:border-surface-800 pt-4">
            <label className="flex items-center gap-3 cursor-pointer mb-3">
              <input
                type="checkbox"
                checked={params.thresholdEnabled}
                onChange={(e) => setParams((p) => ({ ...p, thresholdEnabled: e.target.checked }))}
                className="w-4 h-4 rounded border-surface-300 dark:border-surface-700 text-accent-600 focus:ring-accent-500"
              />
              <span className="text-sm font-medium text-surface-700 dark:text-surface-300">Threshold (Binary Cut)</span>
            </label>
            {params.thresholdEnabled && (
              <ParamSlider
                label="Threshold Level"
                value={params.threshold}
                min={0}
                max={255}
                step={1}
                onChange={(v: number) => setParams((p) => ({ ...p, threshold: v }))}
              />
            )}
          </div>
        </div>

        {/* 3D Parameters */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">3D Settings</h3>
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
        </div>

        {/* Download */}
        <button
          onClick={handleDownloadStl}
          disabled={!processedData || downloading}
          className={`w-full py-2.5 rounded-tool text-sm font-medium transition-all ${
            processedData
              ? "bg-accent-600 text-white hover:bg-accent-700 active:scale-[0.98]"
              : "bg-surface-200 dark:bg-surface-800 text-surface-400 cursor-not-allowed"
          }`}
        >
          {downloading ? "Generating..." : "Download STL"}
        </button>
      </div>

      {/* 3D Heightmap Preview */}
      <div className="flex flex-col gap-4">
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 overflow-hidden bg-surface-100 dark:bg-surface-800 aspect-square">
          {processedData ? (
              <Suspense fallback={<PreviewPlaceholder />}>
                <ThreePreview
                  mode="heightmap"
                  imageData={processedData}
                  params={params}
                />
              </Suspense>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center p-12">
              <svg className="w-10 h-10 text-surface-400 mb-2" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-sm text-surface-400">Upload image to edit heightmap</p>
            </div>
          )}
        </div>
        <div className="p-3 rounded-lg bg-surface-100 dark:bg-surface-800/50">
          <p className="text-2xs text-surface-500 leading-relaxed">
            <strong className="text-surface-700 dark:text-surface-300">Contrast:</strong> Higher values increase the difference between light and dark areas.{" "}
            <strong className="text-surface-700 dark:text-surface-300">Threshold:</strong> Converts image to pure black and white for crisp, letterpress-style models.
          </p>
        </div>
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
        <span className="text-xs font-mono text-surface-400">{typeof value === "number" && (label.includes("Contrast") || label.includes("Brightness") || label.includes("Level")) ? value : value.toFixed(1)}</span>
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
