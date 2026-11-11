<script lang="ts">
  import { Card, CardBody, Text } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
</script>

<Text size="small">{$t('other_variables')}</Text>

<Card class="mt-2 bg-light-50 text-sm shadow-none">
  <CardBody>
    <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      <div>
        <Text fontWeight="medium" size="tiny" color="primary" class="mb-1">{$t('filename')}</Text>
        <ul>
          <li>{`{{filename}}`} - IMG_123</li>
          <li>{`{{ext}}`} - jpg</li>
        </ul>
      </div>

      <div>
        <Text fontWeight="medium" size="tiny" color="primary" class="mb-1">{$t('filetype')}</Text>
        <ul>
          <li>
            {`{{filetype}}`} - {$t('admin.storage_template_filetype_example', {
              values: { video: 'VID', image: 'IMG' },
            })}
          </li>
          <li>
            {`{{filetypefull}}`} - {$t('admin.storage_template_filetype_full_example', {
              values: { video: 'VIDEO', image: 'IMAGE' },
            })}
          </li>
        </ul>
      </div>

      <div>
        <Text fontWeight="medium" size="tiny" color="primary" class="mb-1">{$t('camera')}</Text>
        <ul>
          <li>{`{{make}}`} - FUJIFILM</li>
          <li>{`{{model}}`} - X-T50</li>
          <li>{`{{lensModel}}`} - XF27mm F2.8 R WR</li>
        </ul>
      </div>

      <div>
        <Text fontWeight="medium" size="tiny" color="primary" class="mb-1">{$t('album')}</Text>
        <ul>
          <li>{`{{album}}`} - {$t('album_name')}</li>
          <li>
            {`{{album-startDate-x}}`} - {$t('admin.storage_template_album_start_date', {
              values: { example: 'album-startDate-yy' },
            })}
            {$t('admin.storage_template_date_time_sample', { values: { date: '2021-12-31T05:32:41.750' } })}
          </li>
          <li>
            {`{{album-endDate-x}}`} - {$t('admin.storage_template_album_end_date', {
              values: { example: 'album-endDate-MM' },
            })}
            {$t('admin.storage_template_date_time_sample', { values: { date: '2023-05-06T09:15:17.100' } })}
          </li>
        </ul>
      </div>
      <div>
        <Text fontWeight="medium" size="tiny" color="primary" class="mb-1">{$t('other')}</Text>
        <ul>
          <li>{`{{assetId}}`} - {$t('admin.storage_template_asset_id')}</li>
          <li>{`{{assetIdShort}}`} - {$t('admin.storage_template_asset_id_short')}</li>
        </ul>
      </div>
    </div>
  </CardBody>
</Card>
