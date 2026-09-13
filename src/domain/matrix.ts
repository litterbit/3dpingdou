import { clamp, colorKey, median, rgbAt } from "./helpers";
import { analyzeOccupancy } from "./occupancy";
import { quantizeColors } from "./quantize";
import type { GridDetection, GridGeometry, PixelMatrix, Raster } from "./types";

// 占位确定后的颜色采样：去掉边缘 16%（格线）和中心 28%..72%（编号），取剩余环形区域的中位数。
export function sampleCellColor(raster: Raster, geometry: GridGeometry, row: number, column: number): [number, number, number] {
  const left = geometry.originX + column * geometry.cellWidth;
  const top = geometry.originY + row * geometry.cellHeight;
  const width = geometry.cellWidth;
  const height = geometry.cellHeight;
  const innerLeft = left + width * 0.16;
  const innerRight = left + width * 0.84;
  const innerTop = top + height * 0.16;
  const innerBottom = top + height * 0.84;
  const centerLeft = left + width * 0.28;
  const centerRight = left + width * 0.72;
  const centerTop = top + height * 0.28;
  const centerBottom = top + height * 0.72;
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let y = clamp(Math.ceil(innerTop), 0, raster.height - 1); y <= clamp(Math.floor(innerBottom), 0, raster.height - 1); y += 1) {
    for (let x = clamp(Math.ceil(innerLeft), 0, raster.width - 1); x <= clamp(Math.floor(innerRight), 0, raster.width - 1); x += 1) {
      if (x >= centerLeft && x <= centerRight && y >= centerTop && y <= centerBottom) continue;
      const color = rgbAt(raster, x, y);
      red.push(color[0]);
      green.push(color[1]);
      blue.push(color[2]);
    }
  }
  return [Math.round(median(red)), Math.round(median(green)), Math.round(median(blue))];
}

export function recognizeMatrix(raster: Raster, detection: Pick<GridDetection, "rows" | "columns" | "geometry"> & { occupancy?: boolean[] }, _backgroundCell = 0, maxColors?: number): PixelMatrix {
  const analysis = detection.occupancy ? null : analyzeOccupancy(raster, detection.geometry, detection.rows, detection.columns);
  const occupancy = detection.occupancy ?? analysis?.occupancy ?? [];
  const cells = Array.from({ length: detection.rows * detection.columns }, (_, index) => {
    const row = Math.floor(index / detection.columns);
    const column = index % detection.columns;
    const confidence = analysis?.scores[index] ?? 1;
    return occupancy[index]
      ? { color: sampleCellColor(raster, detection.geometry, row, column), confidence }
      : { color: null, confidence };
  });
  // 拼豆色号很少：把抗锯齿/印刷造成的相近采样色合并成少数几个代表色。
  if (maxColors && maxColors > 0) {
    const quantized = quantizeColors(cells.filter((cell) => cell.color).map((cell) => cell.color as [number, number, number]), maxColors);
    let cursor = 0;
    cells.forEach((cell) => { if (cell.color) { cell.color = quantized[cursor]; cursor += 1; } });
  }
  return { rows: detection.rows, columns: detection.columns, background: [255, 255, 255], cells };
}

// 把矩阵中所有 from 色格替换为 to 色；无匹配或同色时原样返回，方便调用方跳过历史记录。
export function replaceMatrixColor(matrix: PixelMatrix, from: [number, number, number], to: [number, number, number]): PixelMatrix {
  const key = colorKey(from);
  if (key === colorKey(to) || !matrix.cells.some((cell) => cell.color && colorKey(cell.color) === key)) return matrix;
  return {
    ...matrix,
    cells: matrix.cells.map((cell) => (cell.color && colorKey(cell.color) === key ? { ...cell, color: to } : cell)),
  };
}
