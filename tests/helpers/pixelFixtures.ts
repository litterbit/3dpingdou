import type { Raster } from "../../src/domain/pixel";
import { makeRaster, setPixel, type RgbColor } from "./beadFixtures";

export interface PixelArtFixture {
  raster: Raster;
  rows: number;
  columns: number;
  colors: (RgbColor | null)[][];
}

/**
 * 合成像素截图：小矩阵每格放大 scale 倍（非整数，模拟随手放大的截图），
 * 再做盒式模糊模拟抗锯齿。null 格渲染为近白背景。
 */
export function makePixelArtFixture(colors: (RgbColor | null)[][], scale = 6.7, blurPasses = 1): PixelArtFixture {
  const rows = colors.length;
  const columns = colors[0].length;
  const width = Math.round(columns * scale);
  const height = Math.round(rows * scale);
  const background: RgbColor = [250, 250, 250];
  const raster = makeRaster(width, height, [...background, 255]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = colors[Math.min(rows - 1, Math.floor(y / scale))][Math.min(columns - 1, Math.floor(x / scale))] ?? background;
      setPixel(raster, x, y, [color[0], color[1], color[2], 255]);
    }
  }
  for (let pass = 0; pass < blurPasses; pass++) {
    const copy = new Uint8ClampedArray(raster.data);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) sum += copy[((y + dy) * width + x + dx) * 4 + c];
          }
          raster.data[(y * width + x) * 4 + c] = sum / 9;
        }
      }
    }
  }
  return { raster, rows, columns, colors };
}
