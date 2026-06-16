import { useEffect, useRef } from "react";
import createGlobe, { type Marker, type Arc } from "cobe";

export type GlobeMarker = Marker;
export type GlobeArc = Arc;

/** 点阵自转地球（纯背景装饰）：节点位置以发光 marker 标注，可选流量弧线 */
export default function Globe({ markers, arcs }: { markers: GlobeMarker[]; arcs?: GlobeArc[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markersRef = useRef(markers);
  const arcsRef = useRef(arcs ?? []);
  markersRef.current = markers;
  arcsRef.current = arcs ?? [];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let phi = 0;
    let raf = 0;
    // 用 ResizeObserver 拿真实尺寸，避免布局未完成时 fallback 成小地球而「闪一下」
    let width = canvas.offsetWidth;
    const ro = new ResizeObserver((entries) => {
      width = entries[0].contentRect.width;
    });
    ro.observe(canvas);

    const globe = createGlobe(canvas, {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
      phi: 0,
      theta: 0.25,
      dark: 0,
      diffuse: 1.1,
      mapSamples: 16000,
      mapBrightness: 5.5,
      baseColor: [0.9, 0.94, 0.98],
      markerColor: [0.05, 0.5, 0.85],
      glowColor: [0.85, 0.92, 0.98],
      markers: markersRef.current,
      arcs: arcsRef.current,
      arcColor: [0.13, 0.5, 0.96],
      arcWidth: 0.4,
      arcHeight: 0.4,
    });

    // 仅在拿到有效尺寸的第一帧才淡入，避免 0/小尺寸的闪烁
    let shown = false;
    const tick = () => {
      phi += 0.0035;
      globe.update({
        phi,
        width: width * 2,
        height: width * 2,
        markers: markersRef.current,
        arcs: arcsRef.current,
      });
      if (!shown && width > 0) { shown = true; canvas.style.opacity = "1"; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      globe.destroy();
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="transition-opacity duration-700"
      style={{ width: "100%", height: "100%", opacity: 0 }}
    />
  );
}
