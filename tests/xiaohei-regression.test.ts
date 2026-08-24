import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { detectGrid, fullRoi, type Raster } from "../src/domain/pixel";

function load(path: string): Raster {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

// 回归：小黑图纸没有逐格细线、虚线穿过格心，曾导致 comb 锁到文字边缘晶格
// （相位偏 0.3-0.4 格）+ 虚线污染占位分数，整幅图样识别成空心。
it("xiaohei chart: solid occupancy, no holes, no background noise", () => {
  const raster = load("inputs/小黑图纸.png");
  const detection = detectGrid(raster, fullRoi(raster));
  expect(Math.abs(detection.geometry.cellWidth - 18.7)).toBeLessThan(0.3);
  expect(Math.abs(detection.geometry.cellHeight - 18.7)).toBeLessThan(0.3);
  const { rows, columns, occupancy } = detection;
  const occupied = occupancy.filter(Boolean).length;
  // 图样本体约 2000 格；旧实现只能认出 ~650（边缘格）或混入大量背景噪声。
  expect(occupied).toBeGreaterThan(1700);
  expect(occupied).toBeLessThan(2400);
  // 内部空洞（空格但 8 邻居 ≥7 个有豆）应极少。
  let holes = 0;
  for (let row = 1; row < rows - 1; row += 1) {
    for (let col = 1; col < columns - 1; col += 1) {
      if (occupancy[row * columns + col]) continue;
      let nb = 0;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1)
          if (occupancy[(row + dy) * columns + col + dx]) nb += 1;
      if (nb >= 7) holes += 1;
    }
  }
  expect(holes).toBeLessThan(30);
});
