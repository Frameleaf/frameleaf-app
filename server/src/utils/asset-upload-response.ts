import { BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AssetUploadResource } from 'src/repositories/asset-upload-resource.repository.js';
import { ASSET_UPLOAD_LIMITS } from 'src/utils/asset-upload-resource.js';

export const assetUploadRequestHeaders = (req: Pick<Request, 'rawHeaders' | 'headers'>) => {
  const single = new Set([
    'content-type',
    'content-encoding',
    'upload-draft-interop-version',
    'upload-complete',
    'upload-offset',
    'upload-length',
    'repr-digest',
    'asset-metadata',
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    if (single.has(name)) {
      if (seen.has(name)) throw new BadRequestException(`Ambiguous ${name}`);
      seen.add(name);
    }
  }
  return req.headers;
};

export const writeAssetUploadHeaders = (
  res: Pick<Response, 'setHeader'>,
  row?: AssetUploadResource,
  limits?: typeof ASSET_UPLOAD_LIMITS,
) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Upload-Draft-Interop-Version', '9');
  const capacity = row ?? limits;
  if (capacity)
    res.setHeader(
      'Upload-Limit',
      `max-size=${capacity.maxSize}, max-append-size=${capacity.maxAppendSize}, max-age=${ASSET_UPLOAD_LIMITS.maxAge}, min-size=1`,
    );
  if (row) {
    res.setHeader('Upload-Offset', row.offset);
    res.setHeader('Upload-Complete', row.state === 'published' && row.ingested ? '?1' : '?0');
    if (row.expectedSize !== null) res.setHeader('Upload-Length', row.expectedSize);
  }
};
