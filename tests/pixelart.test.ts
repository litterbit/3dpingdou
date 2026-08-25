import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { detectPixelArt, fullRoi, type Raster } from "../src/domain/pixel";
import { makePixelArtFixture } from "./helpers/pixelFixtures";

function load(path: string): Raster {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

const P = {
  K: [20, 20, 20] as [number, number, number],
  R: [220, 60, 50] as [number, number, number],
  G: [80, 180, 70] as [number, number, number],
  B: [60, 90, 210] as [number, number, number],
};

// 12 × 9 的合成像素图：白边(null)、黑描边、三色块
const PATTERN: ([number, number, number] | null)[][] = [
  [null, null, null, null, null, null, null, null, null, null, null, null],
  [null, null, P.K, P.K, P.K, null, null, null, null, null, null, null],
  [null, P.K, P.R, P.R, P.R, P.K, null, null, P.B, P.B, null, null],
  [null, P.K, P.R, P.K, P.R, P.K, null, P.B, P.B, P.B, P.B, null],
  [null, P.K, P.R, P.R, P.R, P.K, null, P.B, P.B, P.B, P.B, null],
  [null, null, P.K, P.K, P.K, null, null, null, P.B, P.B, null, null],
  [null, null, null, null, null, null, null, null, null, null, null, null],
  [null, P.G, P.G, P.G, P.G, P.G, P.G, P.G, P.G, P.G, P.G, null],
  [null, null, null, null, null, null, null, null, null, null, null, null],
];

describe("detectPixelArt on synthetic pixel screenshots", () => {
  // scale 12：块 12px，尺寸 144×108。太小的合成图（<10px/块）频谱峰检测不稳定，
  // perfectPixel 原版同样失败（其 estimate_grid_fft 直接返回 None）。
  const fixture = makePixelArtFixture(PATTERN, 12);
  const result = detectPixelArt(fixture.raster, fullRoi(fixture.raster), 16);

  it("recovers the grid count within ±1 (after background trim)", () => {
    // 内容区（去掉白边）应为 10×7
    expect(Math.abs(result.columns - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.rows - 7)).toBeLessThanOrEqual(1);
  });

  it("samples cell colors faithfully", () => {
    // 裁剪后坐标 = 原图案坐标 - (1,1)
    const at = (row: number, col: number) => result.matrix.cells[row * result.columns + col].color;
    const near = (a: [number, number, number] | null, b: [number, number, number]) =>
      !!a && Math.abs(a[0] - b[0]) < 30 && Math.abs(a[1] - b[1]) < 30 && Math.abs(a[2] - b[2]) < 30;
    expect(near(at(1, 2), P.R)).toBe(true); // 红色块中心（原 2,3）
    expect(near(at(2, 7), P.B)).toBe(true); // 蓝色块（原 3,8）
    expect(near(at(6, 4), P.G)).toBe(true); // 绿色长条（原 7,5）
    expect(near(at(0, 1), P.K)).toBe(true); // 黑色描边（原 1,2）
  });

  it("floods the near-white background to empty", () => {
    const at = (row: number, col: number) => result.matrix.cells[row * result.columns + col].color;
    expect(at(0, 0)).toBeNull();
    expect(at(0, result.columns - 1)).toBeNull();
    // 裁剪后最后一行是绿色长条（原第 7 行）；原第 6 行整行空白 → 裁剪后倒数第 2 行应为空
    expect(at(result.rows - 2, 4)).toBeNull();
  });
});

describe("detectPixelArt on real pixel screenshots", () => {
  it("bird: faithful grid and background removal", () => {
    const raster = load("inputs/小鸟像素图.png");
    const result = detectPixelArt(raster, fullRoi(raster), 16);
    // 网格铺满全图 25×17，裁剪白边后图样本体约 17×11
    expect(Math.abs(result.columns - 17)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.rows - 11)).toBeLessThanOrEqual(1);
    const colored = result.matrix.cells.filter((c) => c.color).length;
    expect(colored).toBeGreaterThan(100);
    expect(colored).toBeLessThan(result.columns * result.rows * 0.9);
  });

  it("eevee: faithful grid and background removal", () => {
    const raster = load("inputs/伊布像素图.png");
    const result = detectPixelArt(raster, fullRoi(raster), 16);
    // perfectPixel 原版梯度路径给全图 50×47；裁剪白边后本体约 47×42
    expect(Math.abs(result.columns - 47)).toBeLessThanOrEqual(3);
    expect(Math.abs(result.rows - 42)).toBeLessThanOrEqual(3);
    const colored = result.matrix.cells.filter((c) => c.color).length;
    expect(colored).toBeGreaterThan(700);
    expect(colored).toBeLessThan(result.columns * result.rows * 0.9);
    const colors = new Set(result.matrix.cells.filter((c) => c.color).map((c) => c.color!.join(",")));
    expect(colors.size).toBeLessThanOrEqual(16);
  });
});
