const IMAGE_MAX_SIDE = 1280;
const IMAGE_JPEG_QUALITY = 0.82;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_BATCH_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_BATCH_MAX_COUNT = 5;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Preserve GIF/WebP animation; resize PNG/JPEG with transparency retained for PNG. */
export async function compressImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Canvas would flatten animations. Preserve these bounded originals verbatim.
  if (file.type === "image/gif" || file.type === "image/webp") return dataUrl;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  let { width, height } = img;
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    const ratio = Math.min(IMAGE_MAX_SIDE / width, IMAGE_MAX_SIDE / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }

  const isPng = file.type === "image/png";
  const smallEnough = file.size < 300 * 1024;
  if (isPng && smallEnough && width === img.naturalWidth) {
    return dataUrl; // 原样保留
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, width, height);
  const mime = isPng ? "image/png" : "image/jpeg";
  return canvas.toDataURL(mime, isPng ? undefined : IMAGE_JPEG_QUALITY);
}

