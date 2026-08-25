// 图片类型自动判断：拼豆图纸 vs 像素截图。
// 依据是"格线支持率"：图纸有贯穿整个区域的印刷格线，沿检测到的网格线采样会得到
// 持续的梯度响应；像素图没有格线，检测出的"格线"大多落在平坦色块内部，支持率极低。

import { detectGrid } from "./grid";
import { luminance } from "./helpers";
import type { GridDetection, Raster, Roi } from "./types";

export type ImageKind = "chart" | "pixel";

// 沿检测到的每条网格线均匀采样，统计"附近有边缘"的采样点占比。
// 容忍 ±2px 的线位偏差、梯度阈值放低（12）：印刷格线常常很淡（浅绿/浅蓝），
// 宽松条件对图纸几乎不丢点，而像素图的平坦色块内部依然什么都没有。
// 实测标定（5 张真实输入）：图纸 0.54 / 0.58 / 0.66，像素图 0.17 / 0.19。
function lineSupport(raster: Raster, detection: GridDetection): number {
  const { geometry, rows, columns, roi } = detection;
  let hits = 0;
  let total = 0;
  const edge = (dx: number, dy: number, x: number, y: number) =>
    Math.max(
      Math.abs(luminance(raster, x + dx, y + dy) - luminance(raster, x - dx, y - dy)),
      Math.abs(luminance(raster, x + 2 * dx, y + 2 * dy) - luminance(raster, x, y)),
      Math.abs(luminance(raster, x, y) - luminance(raster, x - 2 * dx, y - 2 * dy)),
    );
  for (let k = 0; k <= columns; k++) {
    const x = geometry.originX + k * geometry.cellWidth;
    for (let y = roi.y + 2; y < roi.y + roi.height - 2; y += 2) {
      total++;
      if (edge(1, 0, x, y) >= 12) hits++;
    }
  }
  for (let k = 0; k <= rows; k++) {
    const y = geometry.originY + k * geometry.cellHeight;
    for (let x = roi.x + 2; x < roi.x + roi.width - 2; x += 2) {
      total++;
      if (edge(0, 1, x, y) >= 12) hits++;
    }
  }
  return total ? hits / total : 0;
}

/** 判定：detectGrid 置信度不太低 且 格线支持率 ≥ 0.35 → 图纸，否则 → 像素图。 */
export function classifyImage(raster: Raster, roi: Roi): ImageKind {
  const detection = detectGrid(raster, roi);
  const support = lineSupport(raster, detection);
  return detection.confidence >= 0.3 && support >= 0.35 ? "chart" : "pixel";
}
