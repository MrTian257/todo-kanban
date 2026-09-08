import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_NOTE_BYTES = 64 * 1024;
export const attachmentPattern = /^attachment:\/\/([a-f0-9]{64})$/;
const legacyPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

export interface Attachment { id: string; url: string; mimeType: string; byteSize: number }

export async function importImage(file: File): Promise<Attachment> {
  if (!isTauri()) throw new Error("请在桌面应用中导入附件");
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 5 MiB");
  return invoke<Attachment>("attachment_import", {
    bytes: Array.from(new Uint8Array(await file.arrayBuffer())), filename: file.name,
  });
}

export function legacyImageBlob(url: string): Blob | null {
  if (url.length > MAX_IMAGE_BYTES * 1.4) return null;
  const match = legacyPattern.exec(url);
  if (!match) return null;
  try {
    const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    return new Blob([bytes], { type: "image/" + match[1] });
  } catch { return null; }
}

export async function imageBlob(url: string): Promise<Blob> {
  const match = attachmentPattern.exec(url);
  if (match) {
    if (!isTauri()) throw new Error("本地附件只能在桌面应用中查看");
    const bytes = await invoke<ArrayBuffer | number[]>("attachment_read", { id: match[1] });
    const raw = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
    const mime = raw[0] === 0x89 ? "image/png" : raw[0] === 0xff ? "image/jpeg" : "image/webp";
    return new Blob([raw], { type: mime });
  }
  const legacy = legacyImageBlob(url);
  if (legacy) return legacy;
  throw new Error("图片引用不受支持，请导入本地附件");
}

export function noteError(note: string, original?: string): string | undefined {
  if (note === original) return undefined;
  if (new TextEncoder().encode(note).length > MAX_NOTE_BYTES) return "描述不能超过 64 KiB，请先迁移历史内嵌图片";
  if (note.includes("data:image/")) return "请先将内嵌图片迁移为附件";
  if ((note.match(/attachment:\/\/[a-f0-9]{64}/g) ?? []).length > 20) return "每条待办最多引用 20 张图片";
  return undefined;
}

// 全部成功后由编辑器一次性更新草稿；失败保留原文。
export async function migrateInlineImages(note: string): Promise<string> {
  const urls = [...new Set(note.match(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) ?? [])];
  if (urls.length > 20) throw new Error("内嵌图片超过 20 张，请分拆任务后再迁移");
  let result = note;
  for (const url of urls) {
    const blob = legacyImageBlob(url);
    if (!blob) throw new Error("存在不支持或超限的内嵌图片，原文已保留");
    const attachment = await importImage(new File([blob], "历史图片", { type: blob.type }));
    result = result.split(url).join(attachment.url);
  }
  const error = noteError(result);
  if (error) throw new Error(error);
  return result;
}
