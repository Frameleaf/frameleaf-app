import { load as trash } from '../(user)/trash/[[photos=photos]]/[[assetId=id]]/+page';
import { load as maintenance } from './maintenance/+page';
import { load as integrityReport } from './maintenance/integrity-report/[type]/+page';
import { load as deduplication } from './physical-deduplication/+page';
import { load as destinations } from './processing-destinations/+page';
import { load as queues } from './queues/+page';
import { load as queue } from './queues/[name]/+page';
import { load as renderWorkers } from './render-workers/+page';
import { load as users } from './users/(list)/+page';
import { load as newUser } from './users/(list)/new/+page';
import { load as user } from './users/[id]/+page';
import { load as editUser } from './users/[id]/edit/+page';

vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));

const id = '0b9f7a3e-5c1d-4e8a-9f2b-1a2b3c4d5e6f';
const at = (path: string) => new URL(`https://example.test${path}`);

/** FL-71: the old administration pages and Trash are Command Center sections; their addresses only redirect. */
describe('old addresses of Command Center sections', () => {
  it.each([
    [
      '/admin/maintenance',
      () => maintenance({ url: at('/admin/maintenance') } as never),
      '/user-settings?area=maintenance',
    ],
    [
      '/admin/maintenance/integrity-report/missing_file',
      () =>
        integrityReport({
          url: at('/admin/maintenance/integrity-report/missing_file'),
          params: { type: 'missing_file' },
        } as never),
      '/user-settings?area=maintenance&section=integrity&report=missing_file',
    ],
    [
      '/admin/physical-deduplication',
      () => deduplication({ url: at('/admin/physical-deduplication') } as never),
      '/user-settings?area=storage&section=deduplication',
    ],
    [
      '/admin/processing-destinations',
      () => destinations({ url: at('/admin/processing-destinations') } as never),
      '/user-settings?area=processing&section=routing',
    ],
    [
      '/admin/queues',
      () => queues({ url: at('/admin/queues') } as never),
      '/user-settings?area=processing&section=queues',
    ],
    [
      '/admin/queues/thumbnail-generation',
      () => queue({ url: at('/admin/queues/thumbnail-generation'), params: { name: 'thumbnail-generation' } } as never),
      '/user-settings?area=processing&section=queues&queue=thumbnail-generation',
    ],
    [
      '/admin/render-workers',
      () => renderWorkers({ url: at('/admin/render-workers') } as never),
      '/user-settings?area=processing&section=render-workers',
    ],
    ['/admin/users', () => users({ url: at('/admin/users') } as never), '/user-settings?area=users&section=accounts'],
    [
      '/admin/users/new',
      () => newUser({ url: at('/admin/users/new') } as never),
      '/user-settings?area=users&section=accounts&new=1',
    ],
    [
      `/admin/users/${id}`,
      () => user({ url: at(`/admin/users/${id}`), params: { id } } as never),
      `/user-settings?area=users&section=accounts&user=${id}`,
    ],
    [
      `/admin/users/${id}/edit`,
      () => editUser({ url: at(`/admin/users/${id}/edit`), params: { id } } as never),
      `/user-settings?area=users&section=accounts&user=${id}&edit=1`,
    ],
    ['/trash', () => trash({ url: at('/trash'), params: {} } as never), '/user-settings?area=trash&section=contents'],
    [
      `/trash/photos/${id}`,
      () => trash({ url: at(`/trash/photos/${id}`), params: { assetId: id } } as never),
      `/user-settings?area=trash&section=contents&assetId=${id}`,
    ],
  ])('redirects %s', async (_path, load, location) => {
    await expect(load()).rejects.toMatchObject({ status: 307, location });
  });
});
