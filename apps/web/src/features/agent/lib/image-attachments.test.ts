import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_ATTACHMENTS,
  fileToAttachment,
  imageAttachErrorMessage,
} from './image-attachments';

describe('fileToAttachment', () => {
  it('rejects unsupported mime, oversize, and capacity', async () => {
    expect(
      await fileToAttachment(
        new File(['x'], 'a.svg', { type: 'image/svg+xml' }),
        0,
      ),
    ).toEqual({ ok: false, error: 'unsupported_type' });

    expect(
      await fileToAttachment(
        new File([new Uint8Array(5 * 1024 * 1024)], 'big.png', {
          type: 'image/png',
        }),
        0,
      ),
    ).toEqual({ ok: false, error: 'too_large' });

    expect(
      await fileToAttachment(
        new File(['x'], 'ok.png', { type: 'image/png' }),
        MAX_IMAGE_ATTACHMENTS,
      ),
    ).toEqual({ ok: false, error: 'too_many' });
  });
});

describe('imageAttachErrorMessage', () => {
  it('mentions the attachment cap', () => {
    expect(imageAttachErrorMessage('too_many')).toContain(
      String(MAX_IMAGE_ATTACHMENTS),
    );
  });
});
