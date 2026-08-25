import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { classifyImage, fullRoi, type Raster } from "../src/domain/pixel";
import { makeNumberedGridFixture } from "./helpers/beadFixtures";
import { makePixelArtFixture } from "./helpers/pixelFixtures";

function load(path: string): Raster {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

describe("classifyImage on synthetic fixtures", () => {
  it("numbered chart fixture → chart", () => {
    const raster = makeNumberedGridFixture({ rows: 8, columns: 10 });
    expect(classifyImage(raster, fullRoi(raster))).toBe("chart");
  });

  it("pixel art fixture → pixel", () => {
    const fixture = makePixelArtFixture([
      [null, [20, 20, 20], [220, 60, 50], null],
      [[20, 20, 20], [220, 60, 50], [220, 60, 50], [60, 90, 210]],
      [null, [20, 20, 20], [60, 90, 210], null],
    ]);
    expect(classifyImage(fixture.raster, fullRoi(fixture.raster))).toBe("pixel");
  });
});

describe("classifyImage on real inputs", () => {
  it.each(["拼豆图纸1.png", "小黑图纸.png", "屏幕截图 2026-08-22 194733.png"])("chart: %s", (name) => {
    const raster = load(`inputs/${name}`);
    expect(classifyImage(raster, fullRoi(raster))).toBe("chart");
  });

  it.each(["小鸟像素图.png", "伊布像素图.png"])("pixel: %s", (name) => {
    const raster = load(`inputs/${name}`);
    expect(classifyImage(raster, fullRoi(raster))).toBe("pixel");
  });
});
