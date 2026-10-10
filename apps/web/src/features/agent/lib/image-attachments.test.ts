import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_ATTACHMENTS,
  attachmentsToContentParts,
  canAcceptMoreAttachments,
  imageAttachErrorMessage,
  railLabelForUserMessage,
  validateImageFile,
} from './image-attachments';

describe('validateImageFile', () => {
  it('accepts a normal png under the limit', () => {
    expect(validateImageFile({ type: 'image/png', size: 1024 }, 0)).toBeNull();
  });

  it('rejects unsupported mime and oversized files', () => {
    expect(validateImageFile({ type: 'image/svg+xml', size: 100 }, 0)).toBe(
      'unsupported_type',
    );
    expect(
      validateImageFile({ type: 'image/png', size: 5 * 1024 * 1024 }, 0),
    ).toBe('too_large');
  });

  it('rejects when the attachment cap is reached', () => {
    expect(
      validateImageFile(
        { type: 'image/jpeg', size: 10 },
        MAX_IMAGE_ATTACHMENTS,
      ),
    ).toBe('too_many');
    expect(canAcceptMoreAttachments(MAX_IMAGE_ATTACHMENTS - 1)).toBe(true);
    expect(canAcceptMoreAttachments(MAX_IMAGE_ATTACHMENTS)).toBe(false);
  });
});

describe('attachmentsToContentParts', () => {
  const attachment = {
    id: 'a1',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,aaa',
    name: 'shot.png',
  };

  it('returns plain string when there are no attachments', () => {
    expect(attachmentsToContentParts('hello', undefined)).toBe('hello');
    expect(attachmentsToContentParts('hello', [])).toBe('hello');
  });

  it('builds multimodal parts and omits empty text', () => {
    expect(attachmentsToContentParts('  look  ', [attachment])).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aaa' },
      },
    ]);
    expect(attachmentsToContentParts('   ', [attachment])).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aaa' },
      },
    ]);
  });
});

describe('railLabelForUserMessage', () => {
  it('prefers text, else image labels', () => {
    expect(railLabelForUserMessage({ content: 'hi' })).toBe('hi');
    expect(
      railLabelForUserMessage({
        content: '  ',
        attachments: [
          {
            id: '1',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,x',
          },
        ],
      }),
    ).toBe('Image');
    expect(
      railLabelForUserMessage({
        content: '',
        attachments: [
          {
            id: '1',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,x',
          },
          {
            id: '2',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,y',
          },
        ],
      }),
    ).toBe('2 images');
  });
});

describe('imageAttachErrorMessage', () => {
  it('returns human-readable copy', () => {
    expect(imageAttachErrorMessage('too_many')).toContain(
      String(MAX_IMAGE_ATTACHMENTS),
    );
  });
});
