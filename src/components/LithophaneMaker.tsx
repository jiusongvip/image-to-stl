"use client";

import { useState, useCallback, useRef, lazy, Suspense } from "react";
import PreviewPlaceholder from "./PreviewPlaceholder";
import {
  generateLithophaneTriangles,
  generateLithophaneStl,
  type LithophaneParams,
  type LithophaneShape,
} from "../lib/lithophane";
import { downloadBlob } from "../lib/stl-utils";

export default function LithophaneMaker() {
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [isDragging, setIsDragging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [params, setParams] = useState<LithophaneParams>({
    minThickness: 0.8,
    maxThickness: 3.2,
    borderWidth: 4,
    borderThickness: 1,
    width: 100,
    height: 100,
    shape: "flat",
    curveRadius: 60,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    if (!imageData) return;
    setDownloading(true);
    try {
      const blob = generateLithophaneStl(imageData, params, fileName, 1);
      downloadBlob(blob, fileName.replace(/\.[^.]+$/, "") + "-lithophane.stl");
    } finally {
      setDownloading(false);
    }
  }, [imageData, params, fileName]);

  const shapeOptions: { value: LithophaneShape; label: string; desc: string }[] = [
    { value: "flat", label: "Flat", desc: "Best for hanging on windows or light boxes" },
    { value: "curved", label: "Curved", desc: "Wraps around a cylindrical lamp" },
    { value: "spherical", label: "Dome", desc: "Creates a dome/sphere effect, best for night lights" },
  ];

  // Map lithophane params to ThreePreview-compatible format
  const previewParams = {
    height: params.maxThickness / 5,
    smoothness: 0.3,
    baseHeight: 0,
    invert: true, // lithophane is always inverted
  };

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
            accept="image/jpeg,image/png,image/bmp,image/webp"
            onChange={handleFileSelect}
            className="hidden"
          />
          {fileName ? (
            <div className="space-y-1">
              <div className="w-10 h-10 mx-auto rounded-lg bg-accent-100 dark:bg-accent-900/30 flex items-center justify-center">
                <svg className="w-5 h-5 text-accent-600 dark:text-accent-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
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
                Drop your photo here for lithophane
              </p>
              <p className="text-2xs text-surface-400">JPG, PNG, BMP, WebP</p>
            </div>
          )}
        </div>

        {/* Shape selector */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Lithophane Shape</h3>
          <div className="grid grid-cols-3 gap-2">
            {shapeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setParams((p) => ({ ...p, shape: opt.value }))}
                className={`p-3 rounded-lg text-center transition-colors text-xs ${
                  params.shape === opt.value
                    ? "bg-accent-600 text-white"
                    : "bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700"
                }`}
              >
                <div className="font-medium mb-0.5">{opt.label}</div>
                <div className="text-2xs opacity-70 leading-tight">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Parameters */}
        <div className="rounded-tool border border-surface-200 dark:border-surface-800 p-5 space-y-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Dimensions</h3>

          <ParamSlider
            label="Max Thickness (mm)"
            value={params.maxThickness}
            min={0.5}
            max={6}
            step={0.1}
            onChange={(v: number) => setParams((p) => ({ ...p, maxThickness: v }))}
          />
          <ParamSlider
            label="Min Thickness (mm)"
            value={params.minThickness}
            min={0.2}
            max={4}
            step={0.1}
            onChange={(v: number) => setParams((p) => ({ ...p, minThickness: v }))}
          />
          <ParamSlider
            label="Border Width (mm)"
            value={params.borderWidth}
            min={0}
            max={15}
            step={1}
            onChange={(v: number) => setParams((p) => ({ ...p, borderWidth: v }))}
          />
          <ParamSlider
            label="Border Thickness (mm)"
            value={params.borderThickness}
            min={0.5}
            max={5}
            step={0.5}
            onChange={(v: number) => setParams((p) => ({ ...p, borderThickness: v }))}
          />
          {params.shape !== "flat" && (
            <ParamSlider
              label="Curve Radius (mm)"
              value={params.curveRadius}
              min={20}
              max={150}
              step={5}
              onChange={(v: number) => setParams((p) => ({ ...p, curveRadius: v }))}
            />
          )}

          <div className="p-3 rounded-lg bg-surface-100 dark:bg-surface-800/50">
            <p className="text-2xs text-surface-500 leading-relaxed">
              <strong className="text-surface-700 dark:text-surface-300">Pro tip:</strong>{" "}
              Print with white or light-colored PLA at 100% infill. Hold up to a light source to reveal
              the image. Thinner areas let more light through, thicker areas appear darker.
            </p>
          </div>
        </div>

        {/* Download */}
        <button
          onClick={handleDownloadStl}
          disabled={!imageData || downloading}
          className={`w-full py-2.5 rounded-tool text-sm font-medium transition-all ${
            imageData
              ? "bg-accent-600 text-white hover:bg-accent-700 active:scale-[0.98]"
              : "bg-surface-200 dark:bg-surface-800 text-surface-400 cursor-not-allowed"
          }`}
        >
          {downloading ? "Generating..." : "Download Lithophane STL"}
        </button>
      </div>

      {/* 3D Preview */}
      <div className="min-h-[400px] lg:min-h-[600px]">
            <Suspense fallback={<PreviewPlaceholder />}>
              <ThreePreview imageData={imageData} params={previewParams} />
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
