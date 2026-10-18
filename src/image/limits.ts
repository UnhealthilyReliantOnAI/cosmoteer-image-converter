/** Resource policy, checked before decoding. No full-size RGBA canvas is allocated. */
export const MAX_IMAGE_PIXELS = 64_000_000;

export const MAX_IMAGE_DIMENSION = 32_768;

export const MAX_IMAGE_BYTES = 256 * 1024 * 1024;

export const RGBA_TILE_PIXELS = 1_048_576;

export const IMAGE_PROCESSING_TIMEOUT_MS = 60_000;

export function validateImageDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('Les dimensions de l’image doivent être des entiers positifs.');
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`Une dimension de l’image dépasse ${MAX_IMAGE_DIMENSION.toLocaleString('fr-FR')} pixels, limite de sécurité du décodage.`);
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error('L’image dépasse 64 millions de pixels : sa mémoire décodée serait excessive.');
  }
}
