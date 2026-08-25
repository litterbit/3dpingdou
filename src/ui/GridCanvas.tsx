import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Raster } from "../domain/types";
import { canvasPoint, drawRaster } from "./helpers";
import type { GridState } from "./types";

/** 校准步骤：原图 + 网格叠加，支持点击交点对齐。 */
export function GridCanvas({ raster, grid, selectedCell, alignMode, onCellClick, onAlign }: {
  raster: Raster;
  grid: GridState;
  selectedCell: number;
  alignMode: boolean;
  onCellClick: (index: number) => void;
  onAlign: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = raster.width;
    canvas.height = raster.height;
    drawRaster(context, raster);
    const { geometry, roi, rows, columns } = grid;
    context.strokeStyle = "rgba(231, 111, 67, .9)";
    context.lineWidth = Math.max(1.5, raster.width / 700);
    context.strokeRect(roi.x, roi.y, roi.width, roi.height);
    context.strokeStyle = "rgba(19, 92, 87, .82)";
    context.lineWidth = Math.max(1, Math.min(2.5, raster.width / 800));
    const right = geometry.originX + columns * geometry.cellWidth;
    const bottom = geometry.originY + rows * geometry.cellHeight;
    context.beginPath();
    for (let column = 0; column <= columns; column += 1) {
      const x = geometry.originX + column * geometry.cellWidth;
      context.moveTo(x, geometry.originY);
      context.lineTo(x, bottom);
    }
    for (let row = 0; row <= rows; row += 1) {
      const y = geometry.originY + row * geometry.cellHeight;
      context.moveTo(geometry.originX, y);
      context.lineTo(right, y);
    }
    context.stroke();
    if (selectedCell >= 0 && selectedCell < rows * columns) {
      const row = Math.floor(selectedCell / columns);
      const column = selectedCell % columns;
      context.fillStyle = "rgba(221, 101, 55, .3)";
      context.fillRect(geometry.originX + column * geometry.cellWidth, geometry.originY + row * geometry.cellHeight, geometry.cellWidth, geometry.cellHeight);
    }
  }, [raster, grid, selectedCell]);

  function click(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = canvasPoint(event, raster);
    if (alignMode) {
      onAlign(point.x, point.y);
      return;
    }
    const { geometry, rows, columns } = grid;
    const column = Math.floor((point.x - geometry.originX) / geometry.cellWidth);
    const row = Math.floor((point.y - geometry.originY) / geometry.cellHeight);
    if (row >= 0 && column >= 0 && row < rows && column < columns) onCellClick(row * columns + column);
  }

  return <canvas ref={canvasRef} onPointerDown={click} className={`source-canvas ${alignMode ? "aligning" : ""}`} aria-label="带网格覆盖的原始图纸" />;
}
