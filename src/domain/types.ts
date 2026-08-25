export interface Raster { width: number; height: number; data: Uint8ClampedArray; }
export interface Roi { x: number; y: number; width: number; height: number; }
export interface GridGeometry { originX: number; originY: number; cellWidth: number; cellHeight: number; }
export interface PixelCell { color: [number, number, number] | null; confidence: number; }
export interface PixelMatrix { rows: number; columns: number; cells: PixelCell[]; background: [number, number, number]; }
export interface OccupancyAnalysis { scores: number[]; threshold: number; occupancy: boolean[]; }
export interface GridDetection { roi: Roi; rows: number; columns: number; geometry: GridGeometry; confidence: number; scores: number[]; threshold: number; occupancy: boolean[]; }
