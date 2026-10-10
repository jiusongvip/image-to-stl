"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { sampleHeightGrid, buildClosedSolid, toHeightMm } from "../lib/solid";

interface Props {
  imageData: ImageData | null;
  params: {
    /** 起伏高度，毫米；预览只按比例显示，不按绝对尺寸 */
    reliefMm?: number;
    smoothness?: number;
    invert?: boolean;
    removeBg?: boolean;
    extrusionDepth?: number;
  };
  svgTriangles?: Tri[] | null;
  mode?: "heightmap" | "svg-extrude";
}

type Tri = { normal: [number, number, number]; vertices: [number, number, number][] };

// 预览用 160 格：足够看清形状，又不至于每次拖动滑块都重建大网格。
const PREVIEW_CELLS = 160;
// 场景里最长边归一化到这么多单位，网格辅助线为 3 单位。
const PREVIEW_SPAN = 1.8;

interface View {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  material: THREE.MeshStandardMaterial;
  mesh: THREE.Mesh | null;
}

export default function ThreePreview({ imageData, params, svgTriangles, mode = "heightmap" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View | null>(null);
  const [hasModel, setHasModel] = useState(false);

  // 依赖只列出真正影响几何的标量：调用方常在每次 render 里新建 params 字面量，
  // 把对象本身放进依赖表会让预览无谓重建。
  const { reliefMm, smoothness, invert, removeBg } = params;

  // 场景、相机、控制器只在挂载时建立一次。拖滑块只换网格，视角保持不动，
  // 用户转到一半不会被弹回初始机位。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0f172a");

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    // 模型平铺在 XZ 平面上，机位要抬高到俯视 3/4 角才看得出浮雕起伏。
    camera.position.set(1.7, 2.5, 2.3);
    camera.lookAt(0, 0.15, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // 不设极角/方位角上下限，鼠标和手指都能把模型转满一圈。
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.15, 0);

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#cbd5e1"),
      roughness: 0.45,
      metalness: 0.12,
      side: THREE.DoubleSide,
    });

    scene.add(new THREE.AmbientLight(0x404060, 2.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 3);
    dirLight.position.set(5, 8, 5);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x8090ff, 1.5);
    fillLight.position.set(-3, 2, -3);
    scene.add(fillLight);
    scene.add(new THREE.GridHelper(3, 20, 0x334155, 0x1e293b));

    viewRef.current = { scene, camera, renderer, controls, material, mesh: null };

    // Animate — but only while the preview is actually on screen and the tab is
    // visible. Gating on IntersectionObserver + visibilitychange keeps the
    // interaction identical: OrbitControls redraws because the loop runs whenever
    // the canvas is visible, and it restarts on the way back.
    let disposed = false;
    let running = false;
    let onScreen = false;

    const frame = () => {
      if (disposed || !running) return;
      requestAnimationFrame(frame);
      controls.update();
      renderer.render(scene, camera);
    };

    const start = () => {
      if (disposed || running || !onScreen || document.hidden) return;
      running = true;
      requestAnimationFrame(frame);
    };

    const stop = () => {
      if (!running) return;
      running = false;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              onScreen = entries.some((e) => e.isIntersecting);
              if (onScreen) start();
              else stop();
            },
            { rootMargin: "200px" },
          )
        : null;
    io?.observe(container);
    document.addEventListener("visibilitychange", onVisibility);

    // Start paused unless the canvas is already in the viewport. Without
    // IntersectionObserver support, run continuously so the preview still works.
    if (!io) {
      onScreen = true;
      start();
    } else {
      const r = container.getBoundingClientRect();
      onScreen = r.top < window.innerHeight + 200 && r.bottom > -200;
      if (onScreen) start();
    }

    const onResize = () => {
      if (disposed) return;
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (io) io.disconnect();
      const v = viewRef.current;
      viewRef.current = null;
      if (v?.mesh) v.mesh.geometry.dispose();
      controls.dispose();
      renderer.dispose();
      material.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // 两种模式走同一条路径：直接拿导出用的真实封闭网格，归一化到场景尺度后平铺在网格上。
    // 这样预览与下载的文件是同一份几何，"Remove background" 等开关也能立刻看见效果。
    let solid: Tri[] | null = null;
    if (mode === "svg-extrude" && svgTriangles) {
      solid = svgTriangles;
    } else if (imageData && mode === "heightmap") {
      const heights = sampleHeightGrid(imageData, {
        invert: !!invert,
        removeBackground: !!removeBg,
        smoothRadius: Math.round((smoothness ?? 0) * 6),
        maxCells: PREVIEW_CELLS,
      });
      // 没有底板：起伏直接从 Z=0 起，最薄处由 solid.ts 兜到 0.01mm 保持水密。
      solid = buildClosedSolid({
        heightsMm: toHeightMm(heights, reliefMm ?? 3),
        widthMm: 100,
      });
    }

    if (view.mesh) {
      view.scene.remove(view.mesh);
      view.mesh.geometry.dispose();
      view.mesh = null;
    }

    if (!solid || solid.length === 0) {
      setHasModel(false);
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const t of solid) {
      for (const v of t.vertices) {
        minX = Math.min(minX, v[0]);
        maxX = Math.max(maxX, v[0]);
        minY = Math.min(minY, v[1]);
        maxY = Math.max(maxY, v[1]);
        minZ = Math.min(minZ, v[2]);
        maxZ = Math.max(maxZ, v[2]);
      }
    }
    const k = PREVIEW_SPAN / (Math.max(maxX - minX, maxZ - minZ) || 1);
    // 真实比例下 4mm 起伏摊在 100mm 宽的面板上几乎看不出来，竖直方向要放大才看得出浮雕；
    // 压模这类本就厚实的实体则按 1 倍显示。
    const flatHeight = (maxY - minY) * k || 1;
    const ky = k * Math.min(8, Math.max(1, (PREVIEW_SPAN * 0.35) / flatHeight));
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    const allVertices: number[] = [];
    const allNormals: number[] = [];
    for (const t of solid) {
      for (const v of t.vertices) {
        allVertices.push((v[0] - cx) * k, (v[1] - minY) * ky, (v[2] - cz) * k);
      }
      for (let i = 0; i < 3; i++) {
        allNormals.push(t.normal[0], t.normal[1], t.normal[2]);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(allVertices, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(allNormals, 3));
    geometry.computeBoundingSphere();

    view.mesh = new THREE.Mesh(geometry, view.material);
    view.scene.add(view.mesh);
    setHasModel(true);
  }, [imageData, reliefMm, smoothness, invert, removeBg, svgTriangles, mode]);

  return (
    <div ref={containerRef} className="w-full h-full rounded-tool overflow-hidden relative">
      {!hasModel && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-900">
          <svg className="w-12 h-12 text-surface-600 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          </svg>
          <p className="text-sm text-surface-400">Upload an image to preview</p>
        </div>
      )}
    </div>
  );
}
