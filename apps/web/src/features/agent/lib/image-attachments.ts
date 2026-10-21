import type { MessageAttachment } from '@desk/agent-models';

/** Max images on one composer send. */
export const MAX_IMAGE_ATTACHMENTS = 20;

/** Max decoded image size before attach (~wire size grows with base64). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Longest edge after client resize — keeps vision payloads practical. */
export const MAX_IMAGE_EDGE_PX = 1568;

const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

type ImageAttachError =
  'unsupported_type' | 'too_large' | 'too_many' | 'read_failed';

type ImageAttachResult =
  | { ok: true; attachment: MessageAttachment }
  | { ok: false; error: ImageAttachError };

/** User-facing copy for ImageAttachError (composer toasts). */
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

function validateImageFile(
  file: { type: string; size: number },
  currentCount: number,
): ImageAttachError | null {
  if (currentCount >= MAX_IMAGE_ATTACHMENTS) return 'too_many';
  if (!ALLOWED_IMAGE_MIME.has(file.type)) return 'unsupported_type';
  if (file.size > MAX_IMAGE_BYTES) return 'too_large';
  return null;
}

function approximateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.ceil((base64.length * 3) / 4);
}

function readFileAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('empty'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Downscale rasters; skip GIFs so animation frames stay intact. */
async function resizeImageDataUrl(
  dataUrl: string,
  mimeType: string,
  maxEdge = MAX_IMAGE_EDGE_PX,
): Promise<{ dataUrl: string; mimeType: string }> {
  if (mimeType === 'image/gif') {
    return { dataUrl, mimeType };
  }
  if (typeof Image === 'undefined' || typeof document === 'undefined') {
    return { dataUrl, mimeType };
  }

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('decode failed'));
    element.src = dataUrl;
  });

  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (sourceWidth <= maxEdge && sourceHeight <= maxEdge) {
    return { dataUrl, mimeType };
  }

  const scale = maxEdge / Math.max(sourceWidth, sourceHeight);
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (!context) return { dataUrl, mimeType };
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const outputMime =
    mimeType === 'image/png' || mimeType === 'image/webp'
      ? mimeType
      : 'image/jpeg';
  const quality = outputMime === 'image/jpeg' ? 0.85 : undefined;
  return {
    dataUrl: canvas.toDataURL(outputMime, quality),
    mimeType: outputMime,
  };
}

/** Validate, optionally resize, and produce a durable MessageAttachment. */
export async function fileToAttachment(
  file: File,
  currentCount: number,
): Promise<ImageAttachResult> {
  const validationError = validateImageFile(file, currentCount);
  if (validationError) return { ok: false, error: validationError };

  try {
    const rawDataUrl = await readFileAsDataUrl(file);
    const resized = await resizeImageDataUrl(rawDataUrl, file.type);
    if (approximateDataUrlBytes(resized.dataUrl) > MAX_IMAGE_BYTES) {
      return { ok: false, error: 'too_large' };
    }
    return {
      ok: true,
      attachment: {
        type: 'image',
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

/** Collect image files from paste or drag-and-drop DataTransfer. */
export function filesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer) return [];

  const fromFileList = Array.from(dataTransfer.files ?? []).filter((file) =>
    file.type.startsWith('image/'),
  );
  if (fromFileList.length > 0) return fromFileList;

  const items = dataTransfer.items;
  if (!items) return [];

  const fromItems: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}
