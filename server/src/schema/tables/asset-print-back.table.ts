import {
  AfterDeleteTrigger,
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  Table,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetVisibility } from 'src/enum.js';
import { asset_visibility_enum } from 'src/schema/enums.js';
import { asset_print_back_released } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * FL-967: the scan of the back of a print, kept with the photo of its front. The back is stored `hidden`, and
 * `backPreviousVisibility` is what it goes back to. Removing the row for any reason (unpairing, deleting the front)
 * restores it through `asset_print_back_released`, so no path can leave a back hidden with nothing pointing at it.
 *
 * `searchText` is the back's text with the owner's corrections, tokenized for search. It lives here and not in
 * `ocr_search` so that a search finds the front and never the back itself.
 *
 * A Locked print is Locked on both sides: pairing refuses a mix, and the two are one lock group afterwards
 * (`AssetRepository.getLockGroupIds`), so a back has its own lock row, sealing and unlock.
 */
@Table('asset_print_back')
@Check({ name: 'asset_print_back_two_assets', expression: '"frontAssetId" <> "backAssetId"' })
@Index({
  name: 'idx_asset_print_back_search_text',
  using: 'gin',
  expression: 'f_unaccent("searchText") gin_trgm_ops',
})
@AfterDeleteTrigger({ scope: 'row', function: asset_print_back_released })
export class AssetPrintBackTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', nullable: false, primary: true })
  frontAssetId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', nullable: false, unique: true })
  backAssetId!: string;

  @Column({ enum: asset_visibility_enum })
  backPreviousVisibility!: AssetVisibility;

  @Column({ type: 'text', default: '' })
  searchText!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
