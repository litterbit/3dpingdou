import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Raster, Roi } from "../domain/types";
import { canvasPoint, drawRaster } from "./helpers";

/** 框选步骤：用户拖出主图区域。 */
export function RoiCanvas({ raster, roi, onChange }: { raster: Raster; roi: Roi | null; onChange: (roi: Roi) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Roi | null>(null);
  const shown = draft ?? roi;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = raster.width;
    canvas.height = raster.height;
    drawRaster(context, raster);
    if (!shown) return;
    const x = Math.min(shown.x, shown.x + shown.width);
    const y = Math.min(shown.y, shown.y + shown.height);
    const width = Math.abs(shown.width);
    const height = Math.abs(shown.height);
    context.fillStyle = "rgba(10, 20, 20, .5)";
    context.fillRect(0, 0, raster.width, y);
    context.fillRect(0, y + height, raster.width, raster.height - y - height);
    context.fillRect(0, y, x, height);
    context.fillRect(x + width, y, raster.width - x - width, height);
    context.strokeStyle = "#e76f43";
    context.lineWidth = Math.max(2, raster.width / 500);
    context.strokeRect(x, y, width, height);
  }, [raster, shown]);

  function down(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = canvasPoint(event, raster);
    setDraft({ ...dragStart.current, width: 0, height: 0 });
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!dragStart.current) return;
    const point = canvasPoint(event, raster);
    setDraft({ x: dragStart.current.x, y: dragStart.current.y, width: point.x - dragStart.current.x, height: point.y - dragStart.current.y });
  }

  function up() {
    if (draft && Math.abs(draft.width) >= 8 && Math.abs(draft.height) >= 8) {
      onChange({
        x: Math.min(draft.x, draft.x + draft.width),
        y: Math.min(draft.y, draft.y + draft.height),
        width: Math.abs(draft.width),
        height: Math.abs(draft.height),
      });
    }
    dragStart.current = null;
    setDraft(null);
  }

  return <canvas ref={canvasRef} className="source-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} aria-label="拖动框选主图区域" />;
}
