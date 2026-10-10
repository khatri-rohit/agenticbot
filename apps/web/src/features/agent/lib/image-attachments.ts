import type { ChatContentPart, MessageAttachment } from '@org/agent-models';

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_EDGE_PX = 1568;

export const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** Rough vision-token stand-in for the context meter (~1k tokens / image). */
export const ESTIMATED_TOKENS_PER_IMAGE = 1000;

export type ImageAttachError =
  'unsupported_type' | 'too_large' | 'too_many' | 'read_failed';

export type ImageAttachResult =
  | { ok: true; attachment: MessageAttachment }
  | { ok: false; error: ImageAttachError };

export function imageAttachErrorMessage(error: ImageAttachError): string {
  switch (error) {
    case 'unsupported_type':
      return 'Only PNG, JPEG, WebP, and GIF images are supported.';
    case 'too_large':
      return 'Image is too large (max 4 MB).';
    case 'too_many':
      return `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`;
    case 'read_failed':
      return 'Could not read that image.';
  }
}

export function canAcceptMoreAttachments(currentCount: number): boolean {
  return currentCount < MAX_IMAGE_ATTACHMENTS;
}

/** Pure validation used by tests and before async convert. */
export function validateImageFile(
  file: { type: string; size: number },
  currentCount: number,
): ImageAttachError | null {
  if (!canAcceptMoreAttachments(currentCount)) return 'too_many';
  if (!ALLOWED_IMAGE_MIME.has(file.type)) return 'unsupported_type';
  if (file.size > MAX_IMAGE_BYTES) return 'too_large';
  return null;
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('empty'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Downscale to max edge (browser only). Falls back to original data URL
 * when Image/canvas is unavailable (e.g. Node tests).
 */
export async function resizeImageDataUrl(
  dataUrl: string,
  mimeType: string,
  maxEdge = MAX_IMAGE_EDGE_PX,
): Promise<{ dataUrl: string; mimeType: string }> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') {
    return { dataUrl, mimeType };
  }

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('decode failed'));
    el.src = dataUrl;
  });

  const { naturalWidth: w, naturalHeight: h } = img;
  if (w <= maxEdge && h <= maxEdge) {
    return { dataUrl, mimeType };
  }

  const scale = maxEdge / Math.max(w, h);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataUrl, mimeType };
  ctx.drawImage(img, 0, 0, tw, th);

  const outMime =
    mimeType === 'image/png' || mimeType === 'image/webp'
      ? mimeType
      : 'image/jpeg';
  const quality = outMime === 'image/jpeg' ? 0.85 : undefined;
  const next = canvas.toDataURL(outMime, quality);
  return { dataUrl: next, mimeType: outMime };
}

export async function fileToAttachment(
  file: File,
  currentCount: number,
): Promise<ImageAttachResult> {
  const validation = validateImageFile(file, currentCount);
  if (validation) return { ok: false, error: validation };

  try {
    const raw = await readFileAsDataUrl(file);
    const resized = await resizeImageDataUrl(raw, file.type);
    if (resized.dataUrl.length > MAX_IMAGE_BYTES * 1.4) {
      // base64 expands ~33%; reject if still huge after resize
      const approxBytes = Math.ceil((resized.dataUrl.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES) {
        return { ok: false, error: 'too_large' };
      }
    }
    return {
      ok: true,
      attachment: {
        id: crypto.randomUUID(),
        mimeType: resized.mimeType,
        dataUrl: resized.dataUrl,
        name: file.name || undefined,
      },
    };
  } catch {
    return { ok: false, error: 'read_failed' };
  }
}

/** Collect image Files from a DataTransfer / clipboard items list. */
export function filesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer) return [];
  const fromFiles = Array.from(dataTransfer.files ?? []).filter((f) =>
    f.type.startsWith('image/'),
  );
  if (fromFiles.length > 0) return fromFiles;

  const items = dataTransfer.items;
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}

/** Map durable attachments → OpenAI multimodal user content parts. */
export function attachmentsToContentParts(
  text: string,
  attachments: MessageAttachment[] | undefined,
): string | ChatContentPart[] {
  if (!attachments?.length) return text;
  const parts: ChatContentPart[] = [];
  const trimmed = text.trim();
  if (trimmed) parts.push({ type: 'text', text: trimmed });
  for (const a of attachments) {
    parts.push({
      type: 'image_url',
      image_url: { url: a.dataUrl },
    });
  }
  return parts;
}

export function railLabelForUserMessage(message: {
  content: string;
  attachments?: MessageAttachment[];
}): string {
  const trimmed = message.content.trim();
  if (trimmed) return trimmed;
  const n = message.attachments?.length ?? 0;
  if (n === 1) return 'Image';
  if (n > 1) return `${n} images`;
  return 'Message';
}
