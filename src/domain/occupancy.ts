import { clamp, distance, median, rgbAt } from "./helpers";
import type { GridGeometry, OccupancyAnalysis, Raster } from "./types";

// 中心像素与格子底色的颜色距离超过该值就视为“墨迹”（编号/符号）。
const INK_DISTANCE = 36;

// 找“贯穿线”行/列：虚线/实线横穿格子时会形成一小段填充率 ≈1 的连续行（列），
// 且带外几乎为空。编号文字也可能整行填满窗口（窄窗口里文字横向占满），但文字
// 实心块通常 ≥4 个满行且相邻行填充较高，所以剔除按带长分级（见函数内注释）。
// 命中的整段连同过渡行一起从统计中剔除，否则背景虚线会把空格的墨迹比例抬到
// 0.2-0.4。漏网的线头由 cellInk 末尾的“线头 veto”兜底。
function lineBands(fills: number[]): boolean[] {
  const excluded = new Array<boolean>(fills.length).fill(false);
  const at = (i: number) => (i >= 0 && i < fills.length ? fills[i] : 0);
  let start = 0;
  while (start < fills.length) {
    if (fills[start] < 0.95) { start += 1; continue; }
    let end = start;
    while (end + 1 < fills.length && fills[end + 1] >= 0.95) end += 1;
    const len = end - start + 1;
    // 过渡行容差只给 ≤2 行的细线；3 行带要求紧邻行直接为空，
    // 避免误伤小号文字（文字实心块通常 ≥4 个满行、相邻行填充 0.6-0.9）。
    const sideOk = (i1: number, i2: number) => (len <= 2 ? at(i1) <= 0.3 || (at(i1) <= 0.75 && at(i2) <= 0.3) : at(i1) <= 0.3);
    if (len <= 3 && sideOk(start - 1, start - 2) && sideOk(end + 1, end + 2)) {
      for (let i = start; i <= end; i += 1) excluded[i] = true;
      // 细线的抗锯齿过渡行（fill > 0.3 的贴边行）一并剔除。
      if (start > 0 && at(start - 1) > 0.3) excluded[start - 1] = true;
      if (end + 1 < fills.length && at(end + 1) > 0.3) excluded[end + 1] = true;
    }
    start = end + 1;
  }
  return excluded;
}

interface CellInk { score: number; base: [number, number, number]; }

// 每格先用自己的四角估计底色，再统计中心区域与底色差异超过阈值的像素比例。
// 黑底白字、白底灰字、红底浅字都能识别，因为比较的是距离而不是明暗。
function cellInk(raster: Raster, left: number, top: number, right: number, bottom: number): CellInk {
  const width = right - left;
  const height = bottom - top;
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const collect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = clamp(Math.ceil(y0), 0, raster.height - 1); y <= clamp(Math.floor(y1), 0, raster.height - 1); y += 1) {
      for (let x = clamp(Math.ceil(x0), 0, raster.width - 1); x <= clamp(Math.floor(x1), 0, raster.width - 1); x += 1) {
        const color = rgbAt(raster, x, y);
        red.push(color[0]);
        green.push(color[1]);
        blue.push(color[2]);
      }
    }
  };
  // 四角 14%..34%，避开格线。
  collect(left + width * 0.14, top + height * 0.14, left + width * 0.34, top + height * 0.34);
  collect(right - width * 0.34, top + height * 0.14, right - width * 0.14, top + height * 0.34);
  collect(left + width * 0.14, bottom - height * 0.34, left + width * 0.34, bottom - height * 0.14);
  collect(right - width * 0.34, bottom - height * 0.34, right - width * 0.14, bottom - height * 0.14);
  const base: [number, number, number] = [median(red), median(green), median(blue)];
  const centerLeft = left + width * 0.24;
  const centerRight = left + width * 0.76;
  const centerTop = top + height * 0.24;
  const centerBottom = top + height * 0.76;
  const x0 = clamp(Math.ceil(centerLeft), 0, raster.width - 1);
  const x1 = clamp(Math.floor(centerRight), 0, raster.width - 1);
  const y0 = clamp(Math.ceil(centerTop), 0, raster.height - 1);
  const y1 = clamp(Math.floor(centerBottom), 0, raster.height - 1);
  const rows = y1 - y0 + 1;
  const cols = x1 - x0 + 1;
  if (rows <= 0 || cols <= 0) return { score: 0, base };
  const inkMask = new Array<boolean>(rows * cols).fill(false);
  const rowFill = new Array<number>(rows).fill(0);
  const colFill = new Array<number>(cols).fill(0);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (distance(rgbAt(raster, x, y), base) > INK_DISTANCE) {
        inkMask[(y - y0) * cols + (x - x0)] = true;
        rowFill[y - y0] += 1;
        colFill[x - x0] += 1;
      }
    }
  }
  const rowExcluded = lineBands(rowFill.map((count) => count / cols));
  const colExcluded = lineBands(colFill.map((count) => count / rows));
  let ink = 0;
  let total = 0;
  // 剩余墨迹的外接框，用于识别“局部线头”：虚线端点落在窗口内时只剩几列宽，
  // 够不到整行 95% 填充的剔除条件，但形状仍是细长实心条（长宽比大、矩形填充率高）。
  let inkMinX = cols;
  let inkMaxX = -1;
  let inkMinY = rows;
  let inkMaxY = -1;
  for (let dy = 0; dy < rows; dy += 1) {
    if (rowExcluded[dy]) continue;
    for (let dx = 0; dx < cols; dx += 1) {
      if (colExcluded[dx]) continue;
      total += 1;
      if (inkMask[dy * cols + dx]) {
        ink += 1;
        if (dx < inkMinX) inkMinX = dx;
        if (dx > inkMaxX) inkMaxX = dx;
        if (dy < inkMinY) inkMinY = dy;
        if (dy > inkMaxY) inkMaxY = dy;
      }
    }
  }
  if (ink > 0) {
    const spanX = inkMaxX - inkMinX + 1;
    const spanY = inkMaxY - inkMinY + 1;
    const aspect = Math.max(spanX, spanY) / Math.min(spanX, spanY);
    const boxFill = ink / (spanX * spanY);
    // 文字笔画是带孔洞的紧凑块（填充率 <0.5、长宽比 <2），线头是细长实心条。
    if (aspect >= 2.2 && boxFill >= 0.55) ink = 0;
  }
  return { score: total ? ink / total : 0, base };
}

// 多级 Otsu（3 类），返回较低的那个分割点。
// 为什么不用普通二分类 Otsu：墨迹分数经常出现三个群体——空白背景（≈0）、
// 有编号文字的有豆格（0.05-0.4，字号越小分数越低）、图样边缘被“底色污染”的格
// （四角采到格外背景，整格误判墨迹，0.6-1.0）。二分类 Otsu 会把阈值放在文字格
// 与污染格之间（≈0.4），小号文字格全部被误判为空。三分割的低阈值正好落在
// 背景与文字之间；只有两类时，低阈值也退化为正常的二分类结果。
export function otsuThreshold(values: readonly number[]): number {
  if (!values.length) return 0;
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (max <= 1e-6) return 0;
  const BINS = 64;
  const histogram = new Array<number>(BINS).fill(0);
  for (const value of values) histogram[Math.min(BINS - 1, Math.floor((value / max) * (BINS - 1e-9)))] += 1;
  const total = values.length;
  // 前缀和：w[i]=累计格数，s[i]=累计 bin 值，便于 O(BINS²) 枚举两个分割点。
  const w = new Array<number>(BINS + 1).fill(0);
  const s = new Array<number>(BINS + 1).fill(0);
  for (let i = 0; i < BINS; i += 1) {
    w[i + 1] = w[i] + histogram[i];
    s[i + 1] = s[i] + i * histogram[i];
  }
  const meanTotal = s[BINS] / total;
  const classVariance = (a: number, b: number) => {
    const weight = w[b] - w[a];
    if (!weight) return 0;
    const mean = (s[b] - s[a]) / weight;
    return weight * (mean - meanTotal) ** 2;
  };
  let bestT1 = 0;
  let bestT2 = 0;
  let bestVariance = -Infinity;
  for (let t1 = 1; t1 < BINS - 1; t1 += 1) {
    if (w[t1] === 0 || w[t1] === total) continue;
    const v0 = classVariance(0, t1);
    for (let t2 = t1 + 1; t2 < BINS; t2 += 1) {
      if (w[t2] === w[t1] || w[t2] === total) continue;
      const variance = v0 + classVariance(t1, t2) + classVariance(t2, BINS);
      if (variance > bestVariance) { bestVariance = variance; bestT1 = t1; bestT2 = t2; }
    }
  }
  const split = bestT1 || bestT2;
  return (split / BINS) * max;
}

export function applyThreshold(scores: readonly number[], threshold: number): boolean[] {
  return scores.map((score) => score > threshold);
}

export function analyzeOccupancy(raster: Raster, geometry: GridGeometry, rows: number, columns: number): OccupancyAnalysis {
  const scores: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = geometry.originX + column * geometry.cellWidth;
      const top = geometry.originY + row * geometry.cellHeight;
      scores.push(cellInk(raster, left, top, left + geometry.cellWidth, top + geometry.cellHeight).score);
    }
  }
  const threshold = otsuThreshold(scores);
  return { scores, threshold, occupancy: applyThreshold(scores, threshold) };
}
