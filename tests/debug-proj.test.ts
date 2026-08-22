import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { it } from "vitest";

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

it("projection peaks", () => {
  const raster = load("inputs/拼豆图纸1.png");
  const lum = (x: number, y: number) => {
    const p = (y * raster.width + x) * 4;
    return raster.data[p] * 0.299 + raster.data[p + 1] * 0.587 + raster.data[p + 2] * 0.114;
  };
  const proj: number[] = [];
  for (let x = 0; x < 200; x += 1) {
    let total = 0;
    for (let y = 0; y < raster.height; y += 2) total += 255 - lum(x, y);
    proj.push(total / Math.ceil(raster.height / 2));
  }
  // 打印 0..160 的投影值，每 10 个一行
  for (let base = 0; base < 160; base += 20) {
    console.log(proj.slice(base, base + 20).map((v, i) => `${base + i}=${v.toFixed(0)}`).join(" "));
  }
});
