// 附件（图片）引用与导入（ADR-013）：
// note 持久化只存 attachment://<todoId>/<file> 短引用；展示/编辑时前缀互换为自定义协议 URL，
// 由 app 壳注册的 attachment 协议直接按相对路径供图（Windows: http://attachment.localhost/…，
// macOS/Linux: attachment://localhost/…）。历史内嵌 data URL 图片继续兼容显示，不做强制迁移。

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";

/** 单张图片上限（压缩后；后端同规则校验） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** note 持久化引用前缀 */
export const ATTACHMENT_REF_PREFIX = "attachment://";
const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
/** 编辑器/预览展示前缀（自定义协议平台差异） */
export const ATTACHMENT_DISPLAY_PREFIX = IS_WINDOWS
  ? "http://attachment.localhost/"
  : "attachment://localhost/";

export interface Attachment {
  id: string;
  /** note 引用形态：attachment://<todoId>/<file> */
  ref: string;
  fileName: string;
  relativePath: string;
  mimeType: string;
  byteSize: number;
}

export interface MigrateSummary {
  scannedTodos: number;
  migratedImages: number;
  failedTodos: { id: string; reason: string }[];
}

export interface GcSummary {
  removedRelations: number;
  removedAttachments: number;
  movedFiles: number;
}

/** 单个引用 → 展示 URL（非引用原样返回） */
export function attachmentDisplayUrl(ref: string): string {
  return ref.startsWith(ATTACHMENT_REF_PREFIX)
    ? ATTACHMENT_DISPLAY_PREFIX + ref.slice(ATTACHMENT_REF_PREFIX.length)
    : ref;
}

/** 整段 markdown：引用形态 → 展示形态（纯前缀互换，精确可逆；用户手输的 attachment:// 原样保留） */
export function attachmentRefToDisplay(markdown: string): string {
  return markdown.split(ATTACHMENT_REF_PREFIX).join(ATTACHMENT_DISPLAY_PREFIX);
}

/** 整段 markdown：展示形态 → 引用形态（保存/对外发布时调用） */
export function attachmentDisplayToRef(markdown: string): string {
  return markdown.split(ATTACHMENT_DISPLAY_PREFIX).join(ATTACHMENT_REF_PREFIX);
}

/** 导入一张图片：按任务归档到 <运行目录>/attachments/<todoId>/<todoId>-<seq>.<ext> */
export async function importImage(file: File, todoId: string): Promise<Attachment> {
  if (!isTauri()) throw new Error("请在桌面应用中导入附件");
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 5 MiB");
  const bytesBase64 = await blobToBase64(file);
  return invoke<Attachment>("attachment_import", { todoId, filename: file.name, bytesBase64 });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("图片读取失败，请重试"));
    reader.readAsDataURL(blob);
  });
}

/** 迁移历史内嵌 base64 图片为附件（逐条任务全成或全不动） */
export async function migrateInlineImages(): Promise<MigrateSummary> {
  if (!isTauri()) throw new Error("请在桌面应用中执行附件维护");
  return invoke<MigrateSummary>("attachment_migrate_inline");
}

/** 清理孤儿附件（关系指向已删除任务 / 无任何关系的附件；文件移入 attachments/trash/） */
export async function gcOrphanAttachments(): Promise<GcSummary> {
  if (!isTauri()) throw new Error("请在桌面应用中执行附件维护");
  return invoke<GcSummary>("attachment_gc_orphans");
}
