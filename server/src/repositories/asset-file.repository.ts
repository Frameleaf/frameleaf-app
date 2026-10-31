import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import type { Kysely } from 'kysely';
import { AssetFileSearchDto } from 'src/dtos/asset-file.dto.js';
import { DB } from 'src/schema/index.js';

const searchFields = ['type', 'isEdited', 'isProgressive', 'isTransparent'] as const;

@Injectable()
export class AssetFileRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  get(id: string) {
    return this.db.selectFrom('asset_file').where('id', '=', id).selectAll().executeTakeFirst();
  }

  search(dto: AssetFileSearchDto) {
    let query = this.db.selectFrom('asset_file').where('assetId', '=', dto.assetId).selectAll();
    for (const field of searchFields) {
      const value = dto[field];
      if (value !== undefined) {
        query = query.where(field, '=', value);
      }
    }
    return query.execute();
  }

  async delete(id: string): Promise<boolean> {
    const { numDeletedRows } = await this.db.deleteFrom('asset_file').where('id', '=', id).executeTakeFirst();
    return Number(numDeletedRows) === 1;
  }
}
