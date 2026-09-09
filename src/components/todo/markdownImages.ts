const IMAGE_MAX_SIDE = 1280;
const IMAGE_JPEG_QUALITY = 0.82;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_BATCH_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_BATCH_MAX_COUNT = 5;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 读取图片尺寸（GIF/WebP 动画也需探测是否超边） */
function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片读取失败，请重试")); };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, mime, quality));
}

/**
 * 压缩/规整图片，返回 Blob（供附件导入）：
 * - GIF/WebP 原样保留（Canvas 会压平动画）；
 * - PNG 小图原样保留；其余按最长边 1280 缩放，PNG 保透明、JPEG 质量 0.82。
 */
export async function compressImage(file: File): Promise<Blob> {
  // Canvas would flatten animations. Preserve these bounded originals verbatim.
  if (file.type === "image/gif" || file.type === "image/webp") return file;

  const img = await loadImage(file);

  let { width, height } = img;
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    const ratio = Math.min(IMAGE_MAX_SIDE / width, IMAGE_MAX_SIDE / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }

  const isPng = file.type === "image/png";
  const smallEnough = file.size < 300 * 1024;
  if (isPng && smallEnough && width === img.naturalWidth) {
    return file; // 原样保留
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, width, height);
  const mime = isPng ? "image/png" : "image/jpeg";
  const blob = await canvasToBlob(canvas, mime, isPng ? undefined : IMAGE_JPEG_QUALITY);
  return blob ?? file;
}
