import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fail } from './errors.js';
import type { BachsState, StoredProduct, StoredUpload } from './state.js';

/**
 * Files (`upl_…`): the generic upload behind product media and Connect
 * documents (`POST /v1/utilities/uploads`, "Maximum size is 20 MB"), and the
 * dispute document upload ("PDF, JPEG, PNG, or GIF up to 10 MB each",
 * guides/disputes/overview). Both mint the same kind of id, so a dispute
 * document is retrievable through `/v1/utilities/uploads/{id}` too.
 */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const DISPUTE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DISPUTE_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'] as const;

/** A product "supports at most 5 media items" (error reference, MEDIA_LIMIT_EXCEEDED). */
export const MEDIA_LIMIT = 5;

/** `scope`: "^[a-z0-9_-]{1,64}$", default `general`. */
const SCOPE = /^[a-z0-9_-]{1,64}$/;

/**
 * "The media type detected from the file's contents, which may differ from
 * what its extension suggests": the signatures paybox knows, or null.
 */
export function detectMimeType(bytes: Buffer): string | null {
  const starts = (signature: number[], offset = 0) => signature.every((byte, i) => bytes[offset + i] === byte);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** A general upload's type: detected where paybox can, else what the client declared. */
export function sniffMimeType(bytes: Buffer, declared: string | undefined): string {
  return detectMimeType(bytes) ?? (declared || 'application/octet-stream');
}

/** One field's failure, in the validation shape every Bachs 400 uses. */
function fieldError(field: string, message: string, missing = false): z.ZodError {
  return new z.ZodError([
    missing
      ? { code: 'invalid_type', path: [field], message, expected: 'string', input: undefined }
      : { code: 'custom', path: [field], message, input: null },
  ]);
}

/**
 * Read a `multipart/form-data` body: the `file` part and any plain fields.
 * The size limit is checked here rather than left to the parser, so an
 * oversized file is a Bachs validation error and not a bare 413.
 */
export async function readMultipartFile(
  request: FastifyRequest,
  maxBytes: number,
): Promise<{ bytes: Buffer; fileName: string; declaredType: string | undefined; fields: Record<string, string> }> {
  if (!request.isMultipart()) throw fieldError('file', 'Field required', true);
  const fields: Record<string, string> = {};
  let file: { bytes: Buffer; fileName: string; declaredType: string | undefined } | null = null;
  try {
    for await (const part of request.parts({ limits: { fileSize: maxBytes, files: 1 } })) {
      if (part.type === 'file') {
        const bytes = await part.toBuffer();
        if (part.fieldname === 'file') file = { bytes, fileName: part.filename, declaredType: part.mimetype };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw fieldError('file', `The file exceeds the ${maxBytes / (1024 * 1024)} MB limit.`);
    }
    if ((error as { code?: string }).code === 'FST_FILES_LIMIT') {
      throw fieldError('file', 'Send one file per request.');
    }
    throw error;
  }
  if (!file) throw fieldError('file', 'Field required', true);
  if (file.bytes.length === 0) throw fieldError('file', 'The file is empty.');
  return { ...file, fields };
}

export function assertScope(scope: string): void {
  if (!SCOPE.test(scope)) throw fieldError('scope', 'scope must match ^[a-z0-9_-]{1,64}$.');
}

/** A dispute document's type, from its contents only: a declared type proves nothing. */
export function disputeDocumentType(bytes: Buffer): string {
  const detected = detectMimeType(bytes);
  if (detected === null || !(DISPUTE_DOCUMENT_TYPES as readonly string[]).includes(detected)) {
    throw fieldError('file', 'Dispute documents must be PDF, JPEG, PNG, or GIF.');
  }
  return detected;
}

/**
 * An upload id named in a request: it must exist, and must not already be
 * attached to something other than `target`. An upload is attached to one
 * resource, which is what makes "cannot be deleted while attached" mean
 * anything.
 */
export async function requireUpload(
  state: BachsState,
  id: string,
  field: string,
  target: { type: string; id: string },
): Promise<StoredUpload> {
  const upload = await state.uploads.get(id);
  if (!upload) {
    throw fail('validation_failed', 'INVALID_UPLOAD_REFERENCE', `${field}: upload \`${id}\` was not found.`, {
      field,
    });
  }
  const elsewhere =
    upload.linkedResourceId !== null &&
    (upload.linkedResourceType !== target.type || upload.linkedResourceId !== target.id);
  // A dispute document is served only through the API; a product's media is
  // public, and has a `url` to show.
  if (upload.private && target.type === 'product') {
    throw fail(
      'validation_failed',
      'INVALID_UPLOAD_REFERENCE',
      `${field}: upload \`${id}\` is a dispute document and cannot be product media.`,
      { field },
    );
  }
  if (elsewhere) {
    throw fail(
      'validation_failed',
      'INVALID_UPLOAD_REFERENCE',
      `${field}: upload \`${id}\` is already attached to ${upload.linkedResourceType} ${upload.linkedResourceId}.`,
      { field },
    );
  }
  return upload;
}

/** Types a browser may render from paybox's own origin; anything else is served as a download. */
const INLINE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function isInlineType(mimeType: string): boolean {
  return INLINE_TYPES.includes(mimeType);
}

/**
 * `Content-Disposition` for a download: an ASCII fallback, and the real name
 * as RFC 5987 UTF-8, so a name outside Latin-1 neither breaks the header nor
 * is lost.
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Where a public upload is served locally; a dispute document has no URL. */
export function uploadUrl(upload: StoredUpload, origin: string): string | null {
  return upload.private ? null : `${origin}/files/${upload.id}/${encodeURIComponent(upload.fileName)}`;
}

/** `UploadResponse`. */
export function serializeUpload(upload: StoredUpload, origin: string) {
  return {
    upload_id: upload.id,
    file_name: upload.fileName,
    mime_type: upload.mimeType,
    file_size_bytes: upload.sizeBytes,
    url: uploadUrl(upload, origin),
    linked_resource_type: upload.linkedResourceType,
    linked_resource_id: upload.linkedResourceId,
    created_at: upload.createdAt,
    updated_at: upload.updatedAt,
  };
}

/** `MediaItemResponse`, a product's view of one of its uploads. */
export function serializeMediaItem(upload: StoredUpload, origin: string) {
  return {
    id: upload.id,
    url: uploadUrl(upload, origin),
    file_name: upload.fileName,
    mime_type: upload.mimeType,
    file_size_bytes: upload.sizeBytes,
    created_at: upload.createdAt,
  };
}

/** A product's media, in order; an upload deleted since is left out. */
export async function mediaOf(state: BachsState, product: StoredProduct, origin: string) {
  const items = [];
  for (const id of product.media ?? []) {
    const upload = await state.uploads.get(id);
    if (upload) items.push(serializeMediaItem(upload, origin));
  }
  return items;
}

/**
 * Replace a product's media. Every id must name an upload; the ones added
 * are linked to the product, which is what stops them being deleted, and
 * the ones dropped are unlinked again.
 */
export async function replaceMedia(
  state: BachsState,
  product: StoredProduct,
  media: string[],
  now: string,
): Promise<string[]> {
  if (media.length > MEDIA_LIMIT) {
    throw fail(
      'validation_failed',
      'MEDIA_LIMIT_EXCEEDED',
      `A product supports at most ${MEDIA_LIMIT} media items. Remove some before adding more.`,
    );
  }
  const uploads = [];
  const target = { type: 'product', id: product.id };
  for (const [index, id] of media.entries()) uploads.push(await requireUpload(state, id, `media.${index}`, target));
  for (const id of product.media ?? []) {
    if (media.includes(id)) continue;
    const upload = await state.uploads.get(id);
    if (upload?.linkedResourceType === 'product' && upload.linkedResourceId === product.id) {
      await state.uploads.put({ ...upload, linkedResourceType: null, linkedResourceId: null, updatedAt: now });
    }
  }
  for (const upload of uploads) {
    if (upload.linkedResourceId !== null) continue;
    await state.uploads.put({ ...upload, linkedResourceType: 'product', linkedResourceId: product.id, updatedAt: now });
  }
  return [...new Set(media)];
}
