"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

interface Props {
  imageData: ImageData | null;
  params: {
    height: number;
    smoothness: number;
    baseHeight: number;
    invert: boolean;
    extrusionDepth?: number;
  };
  svgTriangles?: Array<{ normal: [number, number, number]; vertices: [number, number, number][] }> | null;
  mode?: "heightmap" | "svg-extrude";
}

// Module-level tracker: ensures we always dispose the previous WebGL context
// even when the effect returns early (noData path) without a cleanup function.
let activeRenderer: THREE.WebGLRenderer | null = null;
let activeAnimId = 0;
let activeControls: OrbitControls | null = null;
let activeContainer: HTMLDivElement | null = null;

function disposeActive() {
  cancelAnimationFrame(activeAnimId);
  activeAnimId = 0;
  if (activeControls) {
    activeControls.dispose();
    activeControls = null;
  }
  if (activeRenderer) {
    activeRenderer.dispose();
    activeRenderer = null;
  }
  if (activeContainer) {
    // Remove only canvas elements (Three.js adds these), not React-managed children
    const canvases = activeContainer.querySelectorAll("canvas");
    canvases.forEach((c) => {
      if (c.parentNode) c.parentNode.removeChild(c);
    });
    activeContainer = null;
  }
}

export default function ThreePreview({ imageData, params, svgTriangles, mode = "heightmap" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const needsImageData = mode === "heightmap" && imageData;
    const needsSvgData = mode === "svg-extrude" && svgTriangles;
    const noData = !needsImageData && !needsSvgData;

    // Always show/hide placeholder based on data availability
    const placeholder = containerRef.current.querySelector("[data-placeholder]") as HTMLElement | null;
    if (placeholder) {
      placeholder.style.display = noData ? "flex" : "none";
    }

    // ALWAYS dispose the previous scene — this is the critical fix for WebGL context leaks
    disposeActive();

    if (noData) return;

    let disposed = false;
    const container = containerRef.current;
    activeContainer = container;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0f172a");

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(2, 1.8, 2.8);
    camera.lookAt(0, 0.2, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    activeRenderer = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.3, 0);
    activeControls = controls;

    // Lighting
    scene.add(new THREE.AmbientLight(0x404060, 2.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 3);
    dirLight.position.set(5, 8, 5);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x8090ff, 1.5);
    fillLight.position.set(-3, 2, -3);
    scene.add(fillLight);

    // Grid
    const gridHelper = new THREE.GridHelper(3, 20, 0x334155, 0x1e293b);
    scene.add(gridHelper);

    if (mode === "svg-extrude" && svgTriangles) {
      const allVertices: number[] = [];
      const allNormals: number[] = [];

      for (const t of svgTriangles) {
        for (const v of t.vertices) {
          allVertices.push(v[0], v[1], v[2]);
        }
        for (let i = 0; i < 3; i++) {
          allNormals.push(t.normal[0], t.normal[1], t.normal[2]);
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(allVertices, 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(allNormals, 3));
      geometry.computeBoundingSphere();

      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#cbd5e1"),
        roughness: 0.4,
        metalness: 0.15,
        side: THREE.DoubleSide,
        flatShading: false,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = 0.1;
      scene.add(mesh);
    } else if (imageData) {
      const { data: pixels, width: iw, height: ih } = imageData;
      const geometry = new THREE.PlaneGeometry(2, (2 * ih) / iw, Math.min(iw, 128) - 1, Math.min(ih, 128) - 1);
      const positions = geometry.attributes.position;

      const { height: hScale, smoothness, baseHeight, invert } = params;

      const rawHeights: number[] = [];
      for (let i = 0; i < positions.count; i++) {
        const x = (positions.getX(i) + 1) / 2;
        const y = 1 - (positions.getY(i) / ((2 * ih) / iw) + 1) / 2;
        const px = Math.floor(x * (iw - 1));
        const py = Math.floor(y * (ih - 1));
        const idx = (py * iw + px) * 4;
        const gray = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3 / 255;
        rawHeights.push(invert ? 1 - gray : gray);
      }

      const smoothRadius = Math.floor(smoothness * 5);
      for (let i = 0; i < positions.count; i++) {
        let sum = rawHeights[i];
        let count = 1;
        for (let dx = -smoothRadius; dx <= smoothRadius; dx++) {
          const col = (i % Math.min(iw, 128)) + dx;
          if (col >= 0 && col < Math.min(iw, 128) && i + dx >= 0 && i + dx < positions.count) {
            sum += rawHeights[i + dx];
            count++;
          }
        }
        positions.setZ(i, (sum / count) * hScale + baseHeight / 20);
      }

      geometry.computeVertexNormals();

      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#cbd5e1"),
        roughness: 0.5,
        metalness: 0.1,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = 0.15;
      scene.add(mesh);

      const backPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(2, (2 * ih) / iw),
        new THREE.MeshStandardMaterial({ color: new THREE.Color("#1e293b"), roughness: 0.9, side: THREE.DoubleSide }),
      );
      backPlane.position.z = -0.02;
      scene.add(backPlane);
    }

    // Animate
    const animate = () => {
      if (disposed) return;
      activeAnimId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!container || disposed) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      disposeActive();
    };
  }, [imageData, params, svgTriangles, mode]);

  return (
    <div ref={containerRef} className="w-full h-full rounded-tool overflow-hidden relative">
      <div data-placeholder className="absolute inset-0 flex-col items-center justify-center bg-surface-900" style={{ display: "flex" }}>
        <svg className="w-12 h-12 text-surface-600 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        </svg>
        <p className="text-sm text-surface-400">Upload an image to preview</p>
      </div>
    </div>
  );
}
