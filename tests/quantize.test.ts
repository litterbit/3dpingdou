import { describe, expect, it } from "vitest";
import { quantizeColors } from "../src/domain/pixel";

describe("quantizeColors", () => {
  it("merges near-identical noisy samples into one representative per bead color", () => {
    // 三种豆子颜色，各自带抗锯齿/印刷噪声。
    const colors: [number, number, number][] = [
      [200, 30, 30], [205, 33, 28], [198, 28, 34],
      [30, 120, 60], [33, 118, 62],
      [240, 240, 235], [250, 250, 250], [255, 255, 255],
    ];
    const result = quantizeColors(colors, 10);
    expect(new Set(result.map((c) => c.join(","))).size).toBe(3);
    // 同一组内的输入必须得到同一个代表色。
    expect(result[0]).toEqual(result[1]);
    expect(result[3]).toEqual(result[4]);
    expect(result[5]).toEqual(result[6]);
    // 代表色应接近组均值而不是偏向某个噪声样本。
    expect(Math.abs(result[0][0] - 201)).toBeLessThanOrEqual(3);
  });

  it("caps the palette at maxColors by merging the closest clusters", () => {
    const colors: [number, number, number][] = [
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 200, 0], [255, 210, 10],
    ];
    const result = quantizeColors(colors, 3);
    expect(new Set(result.map((c) => c.join(","))).size).toBeLessThanOrEqual(3);
    // 最远的三原色应各自保留。
    const unique = new Set(result.map((c) => c.join(",")));
    expect(unique.size).toBe(3);
  });

  it("keeps clearly different colors separate even under a small cap", () => {
    const colors: [number, number, number][] = [[10, 10, 10], [250, 250, 250]];
    const result = quantizeColors(colors, 10);
    expect(new Set(result.map((c) => c.join(","))).size).toBe(2);
  });

  it("handles empty and single-color inputs", () => {
    expect(quantizeColors([], 10)).toEqual([]);
    expect(quantizeColors([[12, 34, 56]], 10)).toEqual([[12, 34, 56]]);
  });
});
