import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { it } from "vitest";

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

it("debug pitch curve", () => {
  const raster = load("inputs/拼豆图纸1.png");
  // reimplement projection inline for inspection
  const lum = (x: number, y: number) => {
    const p = (y * raster.width + x) * 4;
    return raster.data[p] * 0.299 + raster.data[p + 1] * 0.587 + raster.data[p + 2] * 0.114;
  };
  for (const axis of ["x", "y"] as const) {
    const length = axis === "x" ? raster.width : raster.height;
    const cross = axis === "x" ? raster.height : raster.width;
    const step = Math.max(1, Math.ceil(cross / 480));
    const values: number[] = [];
    for (let pos = 0; pos < length; pos += 1) {
      let total = 0; let count = 0;
      for (let other = 0; other < cross; other += step) {
        const x = axis === "x" ? pos : other;
        const y = axis === "x" ? other : pos;
        total += 255 - lum(x, y);
        count += 1;
      }
      values.push(total / count);
    }
    // detrend
    const win = 41;
    const residual = values.map((v, i) => {
      const s = Math.max(0, i - 20); const e = Math.min(values.length, i + 21);
      let local = 0; for (let j = s; j < e; j += 1) local += values[j];
      return v - local / (e - s);
    });
    console.log(`--- axis ${axis} (length ${length})`);
    const out: string[] = [];
    for (let lag = 8; lag <= Math.min(64, Math.floor(length / 4)); lag += 1) {
      let cross2 = 0, left = 0, right = 0;
      for (let i = 0; i < residual.length - lag - 1; i += 1) {
        cross2 += residual[i] * residual[i + lag];
        left += residual[i] ** 2;
        right += residual[i + lag] ** 2;
      }
      const score = cross2 / Math.max(1, Math.sqrt(left * right));
      out.push(`${lag}:${score.toFixed(3)}`);
    }
    console.log(out.join(" "));
  }
});
