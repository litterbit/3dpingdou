import { clamp, interp, luminance, quantile, rgbAt } from "./helpers";
import { analyzeOccupancy } from "./occupancy";
import { normalizeRoi } from "./roi";
import type { GridDetection, GridGeometry, OccupancyAnalysis, Raster, Roi } from "./types";

// 沿某个轴对 ROI 做“梯度能量投影”：Sobel 式亮度差分 + 0.8 分位数。
// 不用暗度中位数：格线、编号文字、色块边缘、虚线都是同周期的合法证据，
// 应该全部保留（网格越淡，编号文字越有价值）。0.8 分位数在“只留贯穿全图的
// 格线”（中位数）和“被大块色块淹没”（平均值）之间取折中。
function projection(raster: Raster, roi: Roi, axis: "x" | "y"): number[] {
  const length = axis === "x" ? roi.width : roi.height;
  const cross = axis === "x" ? roi.height : roi.width;
  const step = Math.max(1, Math.ceil(cross / 480));
  const samples: number[] = [];
  const values = new Array<number>(length).fill(0);
  for (let position = 0; position < length; position += 1) {
    samples.length = 0;
    for (let other = 0; other < cross; other += step) {
      const x = axis === "x" ? roi.x + position : roi.x + other;
      const y = axis === "x" ? roi.y + other : roi.y + position;
      // x 轴信号关心竖向结构（水平方向亮度差），y 轴反之。
      const gradient = axis === "x"
        ? Math.abs(luminance(raster, x + 1, y) - luminance(raster, x - 1, y))
        : Math.abs(luminance(raster, x, y + 1) - luminance(raster, x, y - 1));
      samples.push(gradient);
    }
    values[position] = quantile(samples, 0.8);
  }
  return values;
}

function detrend(values: readonly number[]): number[] {
  const window = 41;
  return values.map((value, index) => {
    const start = Math.max(0, index - Math.floor(window / 2));
    const end = Math.min(values.length, index + Math.ceil(window / 2));
    let local = 0;
    for (let i = start; i < end; i += 1) local += values[i];
    return value - local / Math.max(1, end - start);
  });
}

function correlation(residual: readonly number[], lag: number): number {
  const limit = residual.length - Math.ceil(lag) - 1;
  let cross = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < limit; index += 1) {
    const a = residual[index];
    const b = interp(residual, index + lag);
    cross += a * b;
    left += a * a;
    right += b * b;
  }
  return cross / Math.max(1, Math.sqrt(left * right));
}

// 自相关 + 谐波峰列拟合。不判断“哪个峰是基频”，而是找一个 p 让最多的峰
// 落在 n×p 上，再用全部峰做最小二乘 p = Σn·d / Σn²。
// 亚像素精度来自多个倍频共同回归，不再需要 ±1.5px / 0.05 步长的暴力细化。
// 候选 p 必须满足“1p 处本身有峰”，因此不会锁到 p/2；而 2p 候选会丢掉
// 一半峰（p、3p… 不再是整数倍），证据多的 p 自然胜出。
function findPitch(values: readonly number[]): { pitch: number; score: number } {
  const residual = detrend(values);
  const maxLag = Math.min(64, Math.floor(values.length / 4));
  if (maxLag < 8) return { pitch: Math.max(4, maxLag) || 18, score: 0 };
  const curve: number[] = [];
  for (let lag = 8; lag <= maxLag; lag += 1) curve.push(correlation(residual, lag));
  // 局部峰，三点抛物线插值出亚像素峰位。
  const peaks: Array<{ lag: number; score: number }> = [];
  for (let i = 1; i < curve.length - 1; i += 1) {
    if (curve[i] <= 0 || curve[i] <= curve[i - 1] || curve[i] < curve[i + 1]) continue;
    const denominator = curve[i - 1] - 2 * curve[i] + curve[i + 1];
    const delta = denominator ? clamp(0.5 * (curve[i - 1] - curve[i + 1]) / denominator, -0.5, 0.5) : 0;
    peaks.push({ lag: i + 8 + delta, score: curve[i] });
  }
  if (!peaks.length) return { pitch: 18, score: 0 };
  // 格线↔文字的交叉项会在 p/2 处产生弱峰（幅值通常不到真实谐波的 1/10），
  // 不过滤的话候选 p/2 会靠“峰多”在求和权重上险胜真正的 p。
  const strongest = Math.max(...peaks.map((peak) => peak.score));
  const significant = peaks.filter((peak) => peak.score >= strongest * 0.25);
  let best: { pitch: number; score: number; inliers: Array<{ n: number; lag: number; score: number }> } | null = null;
  for (let p = 8; p <= maxLag; p += 0.1) {
    const tolerance = Math.max(0.8, p * 0.06);
    let hasBase = false;
    let weight = 0;
    const inliers: Array<{ n: number; lag: number; score: number }> = [];
    for (const peak of significant) {
      const n = Math.round(peak.lag / p);
      if (n < 1 || Math.abs(peak.lag - n * p) > tolerance) continue;
      // 1p 基频峰必须足够强：格内若存在每格重复 3 次的结构（如多笔画编号），
      // 会产生 p/3 间隔的密集峰列，否则候选 2p/3 会靠“峰多”累计权重险胜真周期。
      if (n === 1) {
        if (peak.score < strongest * 0.4) continue;
        hasBase = true;
      }
      weight += peak.score;
      inliers.push({ n, lag: peak.lag, score: peak.score });
    }
    if (!hasBase) continue;
    if (!best || weight > best.score) best = { pitch: p, score: weight, inliers };
  }
  if (!best) return { pitch: significant[0].lag, score: 0 };
  // 最小二乘细化：d_n ≈ n·p → p = Σ(n·d) / Σ(n²)
  let sumND = 0;
  let sumNN = 0;
  for (const inlier of best.inliers) {
    sumND += inlier.n * inlier.lag;
    sumNN += inlier.n * inlier.n;
  }
  const pitch = sumNN ? sumND / sumNN : best.pitch;
  const confidence = clamp(best.score / best.inliers.length, 0, 1);
  return { pitch, score: confidence };
}

// comb 搜索：相位只需在 [0, pitch) 内找，让梳齿尽量压在梯度能量高的位置
// （格线/色块边界）。格心不再做惩罚项——编号文字本身就在格心产生梯度，
// 惩罚它会抵消文字这条证据。
// 注意 comb 的最大峰不一定锁在真实格线上：没有逐格细线的图纸里，编号文字的
// 上/下边缘也是逐格重复的梯度结构，能量可能超过每 5 格一条的粗格线，导致
// comb 锁到“文字边缘晶格”（相位偏差可达 0.3-0.4 格）。因此这里返回按能量
// 降序的局部极大候选，最终相位由格内一致性（cellUniformity）仲裁。
function combScore(proj: readonly number[], pitch: number, offset: number): number {
  let border = 0;
  let borderCount = 0;
  for (let k = 0; ; k += 1) {
    const line = offset + k * pitch;
    if (line >= proj.length) break;
    border += interp(proj, line);
    borderCount += 1;
  }
  return border / Math.max(1, borderCount);
}

function phaseCandidates(proj: readonly number[], pitch: number): Array<{ offset: number; score: number }> {
  const steps = Math.max(4, Math.round(pitch / 0.25));
  const curve: number[] = [];
  for (let i = 0; i < steps; i += 1) curve.push(combScore(proj, pitch, (i / steps) * pitch));
  const candidates: Array<{ offset: number; score: number }> = [];
  for (let i = 0; i < steps; i += 1) {
    const prev = curve[(i - 1 + steps) % steps];
    const next = curve[(i + 1) % steps];
    if (curve[i] > prev && curve[i] >= next) candidates.push({ offset: (i / steps) * pitch, score: curve[i] });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 5);
  // 最强候选的半格平移总是纳入候选（文字中心 vs 格线的 p/2 歧义）。
  if (top.length) {
    const half = (top[0].offset + pitch / 2) % pitch;
    if (!top.some((c) => Math.abs(c.offset - half) < 0.5)) top.push({ offset: half, score: 0 });
  }
  return top;
}

// 格内一致性：正确相位下每个格子的四角区域（避开格线与中心编号）应接近单色。
// 相位错半格时四角会横跨两个豆子，方差明显变大。返回归一化后的平均方差。
function cellUniformity(raster: Raster, geometry: GridGeometry, rows: number, columns: number): number {
  const stride = Math.max(1, Math.ceil((rows * columns) / 400));
  let total = 0;
  let counted = 0;
  for (let index = 0; index < rows * columns; index += stride) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const left = geometry.originX + column * geometry.cellWidth;
    const top = geometry.originY + row * geometry.cellHeight;
    const width = geometry.cellWidth;
    const height = geometry.cellHeight;
    const colors: Array<[number, number, number]> = [];
    const collect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = clamp(Math.ceil(y0), 0, raster.height - 1); y <= clamp(Math.floor(y1), 0, raster.height - 1); y += 1) {
        for (let x = clamp(Math.ceil(x0), 0, raster.width - 1); x <= clamp(Math.floor(x1), 0, raster.width - 1); x += 1) {
          colors.push(rgbAt(raster, x, y));
        }
      }
    };
    collect(left + width * 0.14, top + height * 0.14, left + width * 0.34, top + height * 0.34);
    collect(left + width * 0.66, top + height * 0.14, left + width * 0.86, top + height * 0.34);
    collect(left + width * 0.14, top + height * 0.66, left + width * 0.34, top + height * 0.86);
    collect(left + width * 0.66, top + height * 0.66, left + width * 0.86, top + height * 0.86);
    if (colors.length < 4) continue;
    const mean = [0, 0, 0];
    for (const color of colors) { mean[0] += color[0]; mean[1] += color[1]; mean[2] += color[2]; }
    mean[0] /= colors.length; mean[1] /= colors.length; mean[2] /= colors.length;
    let variance = 0;
    for (const color of colors) variance += (color[0] - mean[0]) ** 2 + (color[1] - mean[1]) ** 2 + (color[2] - mean[2]) ** 2;
    total += variance / colors.length;
    counted += 1;
  }
  return counted ? total / counted : Infinity;
}

function trimAnalysis(geometry: GridGeometry, rows: number, columns: number, analysis: OccupancyAnalysis): { geometry: GridGeometry; rows: number; columns: number; analysis: OccupancyAnalysis } {
  let rowMin = rows;
  let rowMax = -1;
  let colMin = columns;
  let colMax = -1;
  analysis.occupancy.forEach((occupied, index) => {
    if (!occupied) return;
    const row = Math.floor(index / columns);
    const column = index % columns;
    rowMin = Math.min(rowMin, row);
    rowMax = Math.max(rowMax, row);
    colMin = Math.min(colMin, column);
    colMax = Math.max(colMax, column);
  });
  if (rowMax < 0) return { geometry, rows, columns, analysis };
  const nextRows = rowMax - rowMin + 1;
  const nextColumns = colMax - colMin + 1;
  if (nextRows === rows && nextColumns === columns) return { geometry, rows, columns, analysis };
  const scores: number[] = [];
  const occupancy: boolean[] = [];
  for (let row = rowMin; row <= rowMax; row += 1) {
    for (let column = colMin; column <= colMax; column += 1) {
      scores.push(analysis.scores[row * columns + column]);
      occupancy.push(analysis.occupancy[row * columns + column]);
    }
  }
  return {
    geometry: { ...geometry, originX: geometry.originX + colMin * geometry.cellWidth, originY: geometry.originY + rowMin * geometry.cellHeight },
    rows: nextRows,
    columns: nextColumns,
    analysis: { scores, threshold: analysis.threshold, occupancy },
  };
}

// 完整自动流程：ROI 内梯度投影 → 谐波拟合亚像素周期 → X/Y 联合校正倍频
// → comb 搜索相位 → 格内一致性裁决 p/2 歧义 → inkRatio + Otsu → 裁剪到有效格外接框。
export function detectGrid(raster: Raster, roi?: Roi | null): GridDetection {
  const region = normalizeRoi(raster, roi);
  const projectionX = projection(raster, region, "x");
  const projectionY = projection(raster, region, "y");
  const pitchX = findPitch(projectionX);
  const pitchY = findPitch(projectionY);
  // 拼豆格近似正方形：两边周期相差整数倍时，几乎必有一边锁到了倍频，
  // 把大的一边除回来（谐波拟合要求 1p 处有峰，小的一边更可信）。
  const ratio = pitchX.pitch / pitchY.pitch;
  const multiple = Math.round(ratio);
  if (multiple >= 2 && Math.abs(ratio - multiple) < 0.12) {
    if (pitchX.pitch > pitchY.pitch) pitchX.pitch /= multiple;
    else pitchY.pitch /= multiple;
  }
  // 相位：comb 给出按能量排序的候选，用格内一致性仲裁——真实格线下每个豆子
  // 格内四角同色，方差最小；锁到文字边缘/文字中心的相位会让格子横跨两个豆子。
  // 平局（单色大色块里多个相位同样均匀）时取 comb 能量高的。
  const candidatesX = phaseCandidates(projectionX, pitchX.pitch);
  const candidatesY = phaseCandidates(projectionY, pitchY.pitch);
  // 行列数按“格心落在 ROI 内”计数：comb 锁到的相位可能偏到格线边缘
  // （梯度投影里一条格线有两个边缘峰），用 round((size-origin)/pitch) 会在
  // ROI 边缘丢掉一整行/列。先按格心归属算出首格索引，再反推原点。
  const lattice = (offset: number, size: number, pitch: number) => {
    const kMin = Math.ceil((0 - offset) / pitch - 0.5);
    const kMax = Math.floor((size - offset) / pitch - 0.5);
    return { start: offset + kMin * pitch, count: Math.max(1, kMax - kMin + 1) };
  };
  let geometry: GridGeometry | null = null;
  let rows = 0;
  let columns = 0;
  let bestUniformity = Infinity;
  let bestComb = -Infinity;
  for (const candX of candidatesX) {
    const latticeX = lattice(candX.offset, region.width, pitchX.pitch);
    for (const candY of candidatesY) {
      const latticeY = lattice(candY.offset, region.height, pitchY.pitch);
      const candidate: GridGeometry = {
        originX: region.x + latticeX.start,
        originY: region.y + latticeY.start,
        cellWidth: pitchX.pitch,
        cellHeight: pitchY.pitch,
      };
      const uniformity = cellUniformity(raster, candidate, latticeY.count, latticeX.count);
      const comb = candX.score + candY.score;
      // 方差差异 <15% 视为平局，让 comb 能量决定（保护文字极少的图纸）。
      if (uniformity < bestUniformity * 0.85 || (uniformity < bestUniformity * 1.15 && comb > bestComb)) {
        bestUniformity = uniformity;
        bestComb = comb;
        geometry = candidate;
        rows = latticeY.count;
        columns = latticeX.count;
      }
    }
  }
  if (!geometry) {
    geometry = { originX: region.x, originY: region.y, cellWidth: pitchX.pitch, cellHeight: pitchY.pitch };
    rows = Math.max(1, Math.round(region.height / pitchY.pitch));
    columns = Math.max(1, Math.round(region.width / pitchX.pitch));
  }
  const trimmed = trimAnalysis(geometry, rows, columns, analyzeOccupancy(raster, geometry, rows, columns));
  return {
    roi: region,
    rows: trimmed.rows,
    columns: trimmed.columns,
    geometry: trimmed.geometry,
    confidence: clamp((pitchX.score + pitchY.score) / 2, 0, 1),
    scores: trimmed.analysis.scores,
    threshold: trimmed.analysis.threshold,
    occupancy: trimmed.analysis.occupancy,
  };
}
