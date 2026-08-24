import { describe, expect, it } from "vitest";
import { floatingBlockOffsets, renderMatrix } from "../src/domain/pixel";
import type { PixelCell, PixelMatrix } from "../src/domain/pixel";

type Rgb = [number, number, number];
const BLACK: Rgb = [20, 20, 20];
const RED: Rgb = [200, 40, 40];

function makeMatrix(rows: number, columns: number, filled: Record<string, Rgb>): PixelMatrix {
  const cells: PixelCell[] = Array.from({ length: rows * columns }, (_, index) => {
    const color = filled[`${Math.floor(index / columns)},${index % columns}`] ?? null;
    return { color, confidence: 1 };
  });
  return { rows, columns, background: [255, 255, 255], cells };
}

const px = (image: ImageData, x: number, y: number) => {
  const p = (y * image.width + x) * 4;
  return [image.data[p], image.data[p + 1], image.data[p + 2], image.data[p + 3]];
};

describe("floatingBlockOffsets", () => {
  it("gives a corner-touching single pixel the diagonal direction toward the body", () => {
    const matrix = makeMatrix(4, 4, {
      "0,0": BLACK,
      "1,1": BLACK, "1,2": BLACK,
      "2,1": BLACK, "2,2": BLACK,
    });
    const result = floatingBlockOffsets(matrix);
    expect(result.fixed).toBe(1);
    expect(result.stranded).toBe(0);
    // 主体在右下方：方向 (+1, +1)。
    expect(result.offsets.get(0)).toEqual([1, 1]);
  });

  it("assigns one shared direction to every cell of a multi-pixel block", () => {
    const matrix = makeMatrix(4, 5, {
      "0,0": BLACK, "0,1": BLACK,
      "1,2": BLACK, "2,2": BLACK, "2,3": BLACK,
    });
    const result = floatingBlockOffsets(matrix);
    expect(result.fixed).toBe(1);
    expect(result.offsets.get(0)).toEqual([1, 1]);
    expect(result.offsets.get(1)).toEqual([1, 1]);
  });

  it("marks blocks that touch the body only via another floating block as stranded", () => {
    // (0,0) 只角接 (1,1)，而 (1,1) 才是角接主体的块：只锚定直接角接主体的块。
    const matrix = makeMatrix(5, 5, {
      "0,0": BLACK,
      "1,1": BLACK,
      "2,2": BLACK, "2,3": BLACK,
      "3,2": BLACK, "3,3": BLACK,
    });
    const result = floatingBlockOffsets(matrix);
    expect(result.fixed).toBe(1);
    expect(result.stranded).toBe(1);
    expect(result.offsets.has(0)).toBe(false);
  });

  it("marks fully detached blocks as stranded without offsets", () => {
    const matrix = makeMatrix(6, 6, {
      "0,0": RED,
      "3,2": BLACK, "3,3": BLACK,
      "4,2": BLACK, "4,3": BLACK,
    });
    const result = floatingBlockOffsets(matrix);
    expect(result.fixed).toBe(0);
    expect(result.stranded).toBe(1);
    expect(result.offsets.size).toBe(0);
  });

  it("returns empty offsets for an already-connected matrix", () => {
    const matrix = makeMatrix(2, 2, { "0,0": BLACK, "0,1": BLACK, "1,0": BLACK, "1,1": BLACK });
    const result = floatingBlockOffsets(matrix);
    expect(result.fixed).toBe(0);
    expect(result.stranded).toBe(0);
    expect(result.offsets.size).toBe(0);
  });
});

describe("renderMatrix with scale and offsets", () => {
  it("keeps the classic 1px-per-cell output by default", () => {
    const matrix = makeMatrix(2, 2, { "0,0": RED, "1,1": BLACK });
    const image = renderMatrix(matrix);
    expect(image.width).toBe(2);
    expect(image.height).toBe(2);
    expect(px(image, 0, 0)).toEqual([...RED, 255]);
    expect(px(image, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it("scales each cell to a solid square without smoothing", () => {
    const matrix = makeMatrix(2, 2, { "0,0": RED, "1,1": BLACK });
    const image = renderMatrix(matrix, { scale: 10 });
    expect(image.width).toBe(20);
    expect(image.height).toBe(20);
    expect(px(image, 0, 0)).toEqual([...RED, 255]);
    expect(px(image, 9, 9)).toEqual([...RED, 255]);
    expect(px(image, 10, 0)).toEqual([0, 0, 0, 0]);
    expect(px(image, 19, 19)).toEqual([...BLACK, 255]);
  });

  it("shifts a corner-touching block so it overlaps the body by offsetPx", () => {
    // 3×3：主体 2×2 在右下，(0,0) 是角接的悬空块；scale=10，offset=2。
    const matrix = makeMatrix(3, 3, {
      "0,0": RED,
      "1,1": BLACK, "1,2": BLACK,
      "2,1": BLACK, "2,2": BLACK,
    });
    const fix = floatingBlockOffsets(matrix);
    const image = renderMatrix(matrix, { scale: 10, offsetPx: 2, offsets: fix.offsets });
    // 画布四周各留 2px 内边距：3*10 + 4 = 34。
    expect(image.width).toBe(34);
    expect(image.height).toBe(34);
    // 悬空块向右下偏移 2px：覆盖 [4,14) × [4,14)。
    expect(px(image, 4, 4)).toEqual([...RED, 255]);
    expect(px(image, 3, 3)).toEqual([0, 0, 0, 0]);
    // 重叠区 [12,14)：悬空块后绘制，压过主体（异色也允许）。
    expect(px(image, 13, 13)).toEqual([...RED, 255]);
    // 主体其余部分不受影响。
    expect(px(image, 20, 20)).toEqual([...BLACK, 255]);
  });

  it("ignores offsets when offsetPx is 0", () => {
    const matrix = makeMatrix(3, 3, {
      "0,0": RED,
      "1,1": BLACK, "1,2": BLACK,
      "2,1": BLACK, "2,2": BLACK,
    });
    const fix = floatingBlockOffsets(matrix);
    const image = renderMatrix(matrix, { scale: 10, offsetPx: 0, offsets: fix.offsets });
    expect(image.width).toBe(30);
    expect(px(image, 5, 5)).toEqual([...RED, 255]);
    expect(px(image, 15, 15)).toEqual([...BLACK, 255]);
  });
});
