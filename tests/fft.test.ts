import { expect, it } from "vitest";
import { fft1d, fft2Magnitude } from "../src/domain/fft";

it("fft1d finds the frequency of a pure cosine", () => {
  const n = 64;
  const k = 5;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n);
  fft1d(re, im);
  const mag = re.map((r, i) => Math.hypot(r, im[i]));
  // 峰值应落在 k 和 n-k 处，幅值 = n/2
  expect(Math.round(mag[k])).toBe(n / 2);
  expect(Math.round(mag[n - k])).toBe(n / 2);
  // 其他频率接近 0
  expect(Math.max(...Array.from(mag.slice(10, 50)))).toBeLessThan(1e-8 * n);
});

it("fft2Magnitude localizes a periodic stripe pattern", () => {
  // 周期 8px 的竖条纹，64x64 → 频谱峰在 center ± 64/8 = ±8 处
  const size = 64;
  const period = 8;
  const gray = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) gray[y * size + x] = x % period < period / 2 ? 30 : 220;
  }
  const { mag, width, height } = fft2Magnitude(gray, size, size);
  const center = width / 2;
  const rows = height;
  const at = (u: number, v: number) => mag[((v + rows) % rows) * width + ((u + width) % width)];
  const peak = at(center + size / period, center);
  expect(peak).toBeGreaterThan(at(center + 3, center) * 10);
  expect(peak).toBeGreaterThan(at(center + 13, center) * 10);
});
