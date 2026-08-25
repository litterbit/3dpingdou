import type { PointerEvent as ReactPointerEvent } from "react";
import type { Raster } from "../domain/types";

export function imageToRaster(image: HTMLImageElement): Raster {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持 Canvas");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: data.data };
}

export function hex(color: readonly number[] | null): string {
  if (!color) return "#ffffff";
  return `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function parseHex(value: string): [number, number, number] {
  const clean = value.replace("#", "");
  return [0, 1, 2].map((index) => Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)) as [number, number, number];
}

export function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>, raster: Raster): { x: number; y: number } {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * raster.width,
    y: ((event.clientY - bounds.top) / bounds.height) * raster.height,
  };
}

export function drawRaster(context: CanvasRenderingContext2D, raster: Raster) {
  context.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
}
