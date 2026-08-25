import type { GridGeometry, Roi } from "../domain/types";

export type Step = "upload" | "crop" | "calibrate" | "edit";
export type Tool = "paint" | "erase" | "pick";
/** 图片类型：自动判断 / 强制拼豆图纸 / 强制像素图 */
export type ModeSetting = "auto" | "chart" | "pixel";

export interface GridState {
  roi: Roi;
  rows: number;
  columns: number;
  geometry: GridGeometry;
  confidence: number;
}

export const STEP_ORDER: Step[] = ["upload", "crop", "calibrate", "edit"];
export const STEP_LABELS = ["01 上传", "02 框选", "03 校准", "04 导出"];

export function titleFor(step: Step): string {
  if (step === "upload") return "把图纸变成真正的像素图";
  if (step === "crop") return "框出要转换的图案";
  if (step === "calibrate") return "校准网格，确认识别";
  return "检查并导出像素图";
}
