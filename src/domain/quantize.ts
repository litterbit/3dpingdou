import { colorKey, distance } from "./helpers";

// ---------- 颜色量化：把相近的采样色合并成少数几个代表色 ----------

// sRGB → CIE Lab（D65），用感知距离而不是 RGB 欧氏距离判断“相近”。
function rgbToLab(color: readonly number[]): [number, number, number] {
  const linear = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(color[0]);
  const g = linear(color[1]);
  const b = linear(color[2]);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (v: number) => (v > 0.008856 ? v ** (1 / 3) : 7.787 * v + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

interface ColorCluster { sum: [number, number, number]; count: number; lab: [number, number, number]; }

function clusterCentroid(cluster: ColorCluster): [number, number, number] {
  return [cluster.sum[0] / cluster.count, cluster.sum[1] / cluster.count, cluster.sum[2] / cluster.count];
}

/**
 * 凝聚式聚类（平均联动）：反复合并质心最近的两个簇，
 * 直到剩余簇数 ≤ maxColors 且最近簇对的 Lab 距离 ≥ mergeDistance。
 * 返回与输入等长的代表色数组（簇质心取整）。
 */
export function quantizeColors(colors: readonly (readonly number[])[], maxColors = 10, mergeDistance = 14): [number, number, number][] {
  const buckets = new Map<string, { color: [number, number, number]; count: number }>();
  colors.forEach((color) => {
    const key = colorKey(color);
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { color: [color[0], color[1], color[2]], count: 1 });
  });
  const clusters: ColorCluster[] = [...buckets.values()].map(({ color, count }) => ({
    sum: [color[0] * count, color[1] * count, color[2] * count],
    count,
    lab: rgbToLab(color),
  }));
  const cap = Math.max(1, Math.round(maxColors));
  while (clusters.length > 1) {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const d = distance(clusters[i].lab, clusters[j].lab);
        if (d < bestDistance) { bestDistance = d; best = i * clusters.length + j; }
      }
    }
    // 簇数已达标、且最近的两个簇也算不上“相近”时停止。
    if (clusters.length <= cap && bestDistance >= mergeDistance) break;
    const i = Math.floor(best / clusters.length);
    const j = best % clusters.length;
    const a = clusters[i];
    const b = clusters[j];
    const merged: ColorCluster = {
      sum: [a.sum[0] + b.sum[0], a.sum[1] + b.sum[1], a.sum[2] + b.sum[2]],
      count: a.count + b.count,
      lab: [0, 0, 0],
    };
    merged.lab = rgbToLab(clusterCentroid(merged));
    clusters.splice(j, 1);
    clusters.splice(i, 1, merged);
  }
  // 每个原始颜色归到质心最近的簇（簇数极少，代价可忽略），用簇质心取整作为代表色。
  const centroids = clusters.map((cluster) => ({ lab: cluster.lab, rgb: clusterCentroid(cluster).map(Math.round) as [number, number, number] }));
  const assignment = new Map<string, [number, number, number]>();
  buckets.forEach(({ color }) => {
    const lab = rgbToLab(color);
    let bestIndex = 0;
    let bestDistance = Infinity;
    centroids.forEach((centroid, index) => {
      const d = distance(lab, centroid.lab);
      if (d < bestDistance) { bestDistance = d; bestIndex = index; }
    });
    assignment.set(colorKey(color), centroids[bestIndex].rgb);
  });
  return colors.map((color) => assignment.get(colorKey(color)) ?? [color[0], color[1], color[2]]);
}
