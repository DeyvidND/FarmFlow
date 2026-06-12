// smartcrop-sharp ships no type definitions. Minimal surface we use: `crop`
// returns the best-scoring crop of the requested aspect, in the source image's
// pixel coordinates.
declare module 'smartcrop-sharp' {
  export function crop(
    input: Buffer | string,
    options: { width: number; height: number; minScale?: number },
  ): Promise<{ topCrop: { x: number; y: number; width: number; height: number } }>;
}
