<script lang="ts">
  /**
   * The photography workspace: a photographer's shoots, each linked to an album they own, with
   * culling, client workflow, presentation and publishing.
   *
   * One noun, "shoot", everywhere. The rail holds the studio-wide places (Shoots, Galleries, Studio
   * website, Watermarks, Branding). An open shoot's own sections are tabs under its strip
   * (PhotographyShootTabs); a section's header names the section and carries a shoot picker, so the
   * shoot stays open while moving between them and each section has one name (PhotographyStatus).
   *
   * Culling never stops: a rating shows at once and saves behind it, one tile at a time. A rating
   * that could not be saved puts that tile back and offers a retry on the tile. Click a photograph to
   * make it current, then arrows move (Up/Down by row), 1-5 rate, X rejects and 0 clears.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Icon } from '@frameleaf/ui';
  import {
    AssetMediaSize,
    getAllAlbums,
    getAssetDevelop,
    type AlbumResponseDto,
    type AssetDevelopResponseDto,
  } from '@frameleaf/sdk';
  import {
    mdiArrowLeft,
    mdiCameraIris,
    mdiCameraOutline,
    mdiCheckAll,
    mdiChevronRight,
    mdiClipboardCheckOutline,
    mdiClockOutline,
    mdiCloseCircleOutline,
    mdiEmailOutline,
    mdiHeartOutline,
    mdiImageEditOutline,
    mdiImageMultipleOutline,
    mdiMagnify,
    mdiPaletteOutline,
    mdiPlus,
    mdiRestore,
    mdiShieldCheckOutline,
    mdiStar,
    mdiStarOutline,
    mdiTrayArrowDown,
    mdiTune,
    mdiWatermark,
    mdiWeb,
  } from '@mdi/js';
  import type { Translations } from 'svelte-i18n';
  import PhotographyBranding from '$lib/components/frameleaf/PhotographyBranding.svelte';
  import PhotographyWorkflow from '$lib/components/frameleaf/PhotographyWorkflow.svelte';
  import PhotographyWatermarks from '$lib/components/frameleaf/PhotographyWatermarks.svelte';
  import PhotographyWebsite from '$lib/components/frameleaf/PhotographyWebsite.svelte';
  import PhotographyNativeSync from '$lib/components/frameleaf/PhotographyNativeSync.svelte';
  import PhotographyShootTabs, { type ShootTab } from '$lib/components/frameleaf/PhotographyShootTabs.svelte';
  import PhotographyThumb from '$lib/components/frameleaf/PhotographyThumb.svelte';
  import PhotographyStatus, {
    photographyErrorKey,
    shootSectionKeys,
    shootStageKeys,
    shootTypeKeys,
  } from '$lib/components/frameleaf/PhotographyStatus.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import {
    loadPhotos,
    loadWorkspace,
    ratePhoto,
    saveWorkspace,
    shootStages,
    shootTypes,
    type Photo,
    type Shoot,
    type Workspace,
  } from '$lib/frameleaf/photography/api';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { isRawName } from '$lib/frameleaf/library-care';
  import { loadWorkflowSummaries, type WorkflowSummary } from '$lib/frameleaf/photography/workflow-api';
  import { DURATION, ICON_SIZE } from '$lib/frameleaf/tokens';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { locale } from '$lib/stores/preferences.store';
  import '$lib/frameleaf/photography/workspace.css';

  /** A shoot's tabs after Photographs; Photographs itself is the open shoot under `shoots`. */
  type ShootSection = Exclude<ShootTab, 'photos'>;
  type Section = 'shoots' | 'galleries' | 'branding' | 'watermarks' | 'website' | ShootSection;
  type PhotoFilter = 'all' | 'selected' | 'edited';
  type ShootFilter = 'all' | 'active' | 'Proofing' | 'Delivered';
  type NextAction = { label: string; icon: string; section: Section; rank: number };

  const shootSectionIds: ReadonlySet<Section> = new Set<ShootSection>(['intake', 'workflow', 'orders', 'presentation']);
  const isShootSection = (value: Section): value is ShootSection => shootSectionIds.has(value);
  /** Sections that work on one shoot at a time, chosen with the picker in the header. */
  const picksShoot = (value: Section) => isShootSection(value) || value === 'galleries';
  /** The prototype's subtitle for each section that works on one shoot. */
  const sectionLeads: Record<ShootSection | 'galleries', Translations> = {
    intake: 'frameleaf_photography_intake_lead',
    workflow: 'frameleaf_photography_workflow_lead',
    orders: 'frameleaf_photography_orders_lead',
    presentation: 'frameleaf_photography_presentation_lead',
    galleries: 'frameleaf_photography_galleries_lead',
  };
  const emptyDraft = (albumId = '') => ({
    name: '',
    client: '',
    type: shootTypes[0] as Shoot['type'],
    date: new Date().toISOString().slice(0, 10),
    albumId,
  });
  /** A key press that belongs to a field, not to culling. */
  const typingInto = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName));

  let {
    initialShoot,
    initialSection,
  }: {
    /** A shoot to open first: the RAW develop editor's way back (FL-420). */
    initialShoot?: string;
    /** `galleries`: the editor's Proof opens the shoot's galleries. */
    initialSection?: 'galleries';
  } = $props();

  // svelte-ignore state_referenced_locally
  let section = $state<Section>(initialShoot && initialSection === 'galleries' ? 'galleries' : 'shoots');
  let shootFilter = $state<ShootFilter>('all');
  let workspace = $state<Workspace>({ revision: null, shoots: [] });
  let workflowSummaries = $state<WorkflowSummary[]>([]);
  let summaryFailed = $state(false);
  let albums = $state<AlbumResponseDto[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let search = $state('');
  let sort = $state('date');
  // svelte-ignore state_referenced_locally
  let activeId = $state<string | null>(initialShoot ?? null);
  let photos = $state<Photo[]>([]);
  let photoLoading = $state(false);
  let photoError = $state('');
  let nextCursor = $state<string | null>(null);
  let tab = $state<PhotoFilter>('all');
  let selected = $state<string[]>([]);
  let compareOpen = $state(false);
  let batchOpen = $state(false);
  let newOpen = $state(false);
  let draft = $state(emptyDraft());
  let details = $state({ name: '', client: '', stage: shootStages[0] as Shoot['stage'] });
  let inspecting = $state<Photo | null>(null);
  let versions = $state<AssetDevelopResponseDto | null>(null);
  let versionError = $state('');
  let versionsLoading = $state(false);
  let grid = $state<HTMLElement>();
  let scroller = $state<HTMLElement>();
  // Opening a shoot or another section starts at its top, not at the scroll offset the list had.
  $effect(() => {
    void activeId;
    void section;
    scroller?.scrollTo({ top: 0 });
  });
  let generation = 0;
  let detailGeneration = 0;
  let versionGeneration = 0;
  let disposed = false;

  // Ratings save behind the grid. `confirmed` is what the server last accepted for a photograph,
  // `turn` the latest request made for it; a failure rolls back only if nothing newer is waiting.
  let ratingGeneration = 0;
  let ratingsSaving = $state(0);
  let ratingFailed = $state<Record<string, number | null>>({});
  let justRated = $state<string[]>([]);
  const confirmed = new Map<string, number | null>();
  const turn = new Map<string, number>();
  const queue = new Map<string, Promise<void>>();

  const active = $derived(workspace.shoots.find(({ id }) => id === activeId));
  const listing = $derived(
    workspace.shoots
      .filter(
        (shoot) =>
          shootFilter === 'all' ||
          (shootFilter === 'active' ? shoot.stage !== 'Delivered' : shoot.stage === shootFilter),
      )
      .filter((shoot) => `${shoot.name} ${shoot.client} ${shoot.type}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.date.localeCompare(a.date))),
  );
  const matches = (photo: Photo, filter: PhotoFilter) =>
    filter === 'all' ||
    (filter === 'selected' && (photo.rating ?? 0) >= 4) ||
    (filter === 'edited' && photo.rating !== -1 && !!photo.currentRevisionId);
  const visible = $derived(photos.filter((photo) => matches(photo, tab)));
  /** FL-420: what "Open in RAW editor" opens: the chosen RAW photographs, else every RAW one. */
  const rawPhotos = $derived(photos.filter((photo) => isRawName(photo.fileName)));
  const chosenRaw = $derived(rawPhotos.filter((photo) => selected.includes(photo.id)).map((photo) => photo.id));
  const availableAlbums = $derived(
    albums.filter(
      (album) =>
        album.albumUsers[0]?.user.id === authManager.user.id &&
        album.kind === 'album' &&
        !album.isSmart &&
        workspace.shoots.every((shoot) => shoot.albumId !== album.id),
    ),
  );
  const cover = (id: string) => getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail });
  const dateLabel = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString($locale, { month: 'short', day: 'numeric', year: 'numeric' });
  const failure = (cause: unknown) => $t(photographyErrorKey(cause));
  const photoFilters: readonly PhotoFilter[] = ['all', 'selected', 'edited'];
  const photoFilterLabel = (filter: PhotoFilter) =>
    filter === 'all'
      ? $t('frameleaf_photography_filter_all')
      : filter === 'selected'
        ? $t('frameleaf_photography_filter_selected')
        : $t('frameleaf_photography_filter_edited');
  const shootFilters: readonly ShootFilter[] = ['all', 'active', 'Proofing', 'Delivered'];
  const shootFilterLabel = (filter: ShootFilter) =>
    filter === 'all'
      ? $t('frameleaf_photography_shoots_all')
      : filter === 'active'
        ? $t('frameleaf_photography_shoots_active')
        : $t(shootStageKeys[filter]);
  const title = $derived(
    section === 'branding'
      ? $t('frameleaf_photography_branding')
      : section === 'watermarks'
        ? $t('frameleaf_photography_watermarks')
        : section === 'website'
          ? $t('frameleaf_photography_studio_website')
          : section === 'galleries'
            ? $t('frameleaf_photography_galleries')
            : isShootSection(section)
              ? $t(shootSectionKeys[section])
              : (active?.name ?? $t('frameleaf_photography_shoots')),
  );
  const subtitle = $derived(
    section === 'branding'
      ? $t('frameleaf_photography_branding_lead')
      : section === 'watermarks'
        ? $t('frameleaf_photography_watermarks_lead')
        : section === 'website'
          ? $t('frameleaf_photography_website_lead')
          : picksShoot(section)
            ? $t(sectionLeads[section as ShootSection | 'galleries'])
            : active
              ? `${active.client} · ${$t(shootTypeKeys[active.type])} · ${dateLabel(active.date)}`
              : $t('frameleaf_photography_shoots_lead'),
  );
  const summaryFor = (id: string) => workflowSummaries.find((row) => row.shootId === id);
  /** Client galleries that have been published: the rail's count beside Galleries. */
  const galleryCount = $derived(
    workflowSummaries.filter((row) => row.published && workspace.shoots.some(({ id }) => id === row.shootId)).length,
  );
  /** A photo of the photographer's own for the branding preview: the open shoot's cover, else any. */
  const samplePhotoId = $derived(
    (active?.unavailable ? null : active?.coverAssetId) ??
      workspace.shoots.find((shoot) => shoot.coverAssetId && !shoot.unavailable)?.coverAssetId ??
      null,
  );

  /**
   * What the shoot needs next, from its client gallery's progress: the line on its card and the
   * "next steps" row. A lower rank needs the photographer sooner.
   */
  function nextAction(shoot: Shoot): NextAction {
    const summary = summaryFor(shoot.id);
    if (shoot.stage === 'Delivered') {
      return { label: $t('frameleaf_photography_next_delivered'), icon: mdiCheckAll, section: 'galleries', rank: 9 };
    }
    if (summary?.pendingEdits) {
      return {
        label: $t('frameleaf_photography_next_edit', { values: { count: summary.pendingEdits } }),
        icon: mdiImageEditOutline,
        section: 'orders',
        rank: 0,
      };
    }
    if (summary?.unpaidOrders) {
      return {
        label: $t('frameleaf_photography_next_payment'),
        icon: mdiClipboardCheckOutline,
        section: 'orders',
        rank: 2,
      };
    }
    if (summary?.readyCount) {
      return { label: $t('frameleaf_photography_next_ready'), icon: mdiCheckAll, section: 'galleries', rank: 1 };
    }
    if (summary?.submittedRounds) {
      return { label: $t('frameleaf_photography_next_review'), icon: mdiHeartOutline, section: 'orders', rank: 0 };
    }
    if (summary?.published && summary.invited === 0) {
      return { label: $t('frameleaf_photography_next_invite'), icon: mdiEmailOutline, section: 'galleries', rank: 1 };
    }
    if (summary?.published) {
      const due = summary.selectionDeadline
        ? ` · ${$t('frameleaf_photography_selections_due', { values: { date: new Date(summary.selectionDeadline).toLocaleDateString($locale) } })}`
        : '';
      return {
        label: `${$t('frameleaf_photography_next_waiting')}${due}`,
        icon: mdiClockOutline,
        section: 'workflow',
        rank: 3,
      };
    }
    return shoot.assetCount
      ? {
          label: $t('frameleaf_photography_next_assemble'),
          icon: mdiImageMultipleOutline,
          section: 'intake',
          rank: 4,
        }
      : { label: $t('frameleaf_photography_next_import'), icon: mdiTrayArrowDown, section: 'intake', rank: 5 };
  }
  /** Up to three active shoots, the ones that need the photographer first. */
  const nextSteps = $derived(
    workspace.shoots
      .filter((shoot) => shoot.stage !== 'Delivered' && !shoot.unavailable)
      .map((shoot) => ({ shoot, action: nextAction(shoot) }))
      .sort((a, b) => a.action.rank - b.action.rank || b.shoot.date.localeCompare(a.shoot.date))
      .slice(0, 3),
  );
  const activeShoots = $derived(workspace.shoots.filter((shoot) => shoot.stage !== 'Delivered').length);
  /** Galleries a client has been invited to and has not sent selections from yet. */
  const awaitingSelections = $derived(
    workflowSummaries.filter((row) => row.published && row.submittedRounds === 0 && row.invited !== 0).length,
  );
  const editingQueue = $derived(workflowSummaries.reduce((total, row) => total + (row.pendingEdits ?? 0), 0));
  /** Unpaid order totals by currency, or null while the server does not report amounts. */
  const outstanding = $derived.by(() => {
    if (workflowSummaries.length === 0 || workflowSummaries.some((row) => row.outstanding === undefined)) {
      return null;
    }
    const totals = new Map<string, number>();
    for (const row of workflowSummaries) {
      const currency = row.currency ?? 'USD';
      totals.set(currency, (totals.get(currency) ?? 0) + (row.outstanding ?? 0));
    }
    return [...totals];
  });
  /** `narrow`: the label already names the currency, so "$0.00" rather than "CA$0.00", as in the prototype. */
  const money = (amount: number, currency: string, narrow = false) => {
    try {
      return new Intl.NumberFormat($locale, {
        style: 'currency',
        currency,
        currencyDisplay: narrow ? 'narrowSymbol' : 'symbol',
      }).format(amount / 100);
    } catch {
      return `${amount / 100} ${currency}`;
    }
  };

  function resetRatings() {
    ratingGeneration++;
    ratingsSaving = 0;
    ratingFailed = {};
    justRated = [];
    confirmed.clear();
    turn.clear();
    queue.clear();
  }

  async function reload() {
    const current = ++generation;
    loading = true;
    error = '';
    try {
      const [stored, sourceAlbums, summaries] = await Promise.all([
        loadWorkspace(),
        getAllAlbums({}),
        loadWorkflowSummaries().catch(() => null),
      ]);
      if (disposed || current !== generation) {
        return;
      }
      workspace = stored;
      albums = sourceAlbums;
      workflowSummaries = summaries?.galleries ?? [];
      summaryFailed = !summaries;
      if (activeId) {
        await openShoot(activeId);
      }
    } catch (error_) {
      if (current === generation) {
        error = failure(error_);
      }
    } finally {
      if (current === generation) {
        loading = false;
      }
    }
  }

  async function persist(shoots: Shoot[]) {
    if (busy) {
      return false;
    }
    const current = generation;
    busy = true;
    error = '';
    message = '';
    try {
      const saved = await saveWorkspace({ revision: workspace.revision, shoots });
      if (disposed || current !== generation) {
        return false;
      }
      workspace = saved;
      message = $t('frameleaf_photography_saved');
      return true;
    } catch (error_) {
      if (current === generation) {
        error = failure(error_);
      }
      return false;
    } finally {
      if (current === generation) {
        busy = false;
      }
    }
  }

  async function openShoot(id: string) {
    activeId = id;
    const shoot = workspace.shoots.find((shoot) => shoot.id === id);
    if (!shoot) {
      activeId = null;
      if (isShootSection(section)) {
        section = 'shoots';
      }
      return;
    }
    details = { name: shoot.name, client: shoot.client, stage: shoot.stage };
    photos = [];
    nextCursor = null;
    selected = [];
    compareOpen = false;
    batchOpen = false;
    tab = 'all';
    inspecting = null;
    versions = null;
    versionGeneration++;
    resetRatings();
    const current = ++detailGeneration;
    photoError = '';
    if (shoot.unavailable) {
      photoLoading = false;
      return;
    }
    photoLoading = true;
    try {
      const page = await loadPhotos(id);
      if (disposed || current !== detailGeneration) {
        return;
      }
      photos = page.photos;
      nextCursor = page.nextCursor;
    } catch (error_) {
      if (current === detailGeneration) {
        photoError = failure(error_);
      }
    } finally {
      if (current === detailGeneration) {
        photoLoading = false;
      }
    }
  }

  async function more() {
    if (!activeId || !nextCursor || photoLoading) {
      return;
    }
    const id = activeId;
    const current = detailGeneration;
    photoLoading = true;
    photoError = '';
    try {
      const page = await loadPhotos(id, nextCursor);
      if (disposed || current !== detailGeneration) {
        return;
      }
      const loaded = new Set(photos.map(({ id }) => id));
      photos = [...photos, ...page.photos.filter((photo) => !loaded.has(photo.id))];
      nextCursor = page.nextCursor;
    } catch (error_) {
      if (current === detailGeneration) {
        photoError = failure(error_);
      }
    } finally {
      if (current === detailGeneration) {
        photoLoading = false;
      }
    }
  }

  function closeShoot() {
    section = 'shoots';
    activeId = null;
    detailGeneration++;
    resetRatings();
  }

  /** A tab under the shoot strip: Photographs is the open shoot itself, the rest are sections. */
  function openTab(tab: ShootTab) {
    section = tab === 'photos' ? 'shoots' : tab;
  }

  /** Opens a shoot straight into one of its sections (a next step, a card's action). */
  async function openShootAt(id: string, target: Section) {
    section = target;
    await openShoot(id);
  }

  /** Galleries works on one shoot: the open one, else the first with a published gallery. */
  function openGalleries() {
    section = 'galleries';
    if (active) {
      return;
    }
    const id =
      workflowSummaries.find((row) => row.published && workspace.shoots.some((shoot) => shoot.id === row.shootId))
        ?.shootId ?? workspace.shoots[0]?.id;
    if (id) {
      void openShoot(id);
    }
  }

  function startShoot() {
    draft = emptyDraft(availableAlbums[0]?.id ?? '');
    newOpen = true;
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const shoot: Shoot = {
      ...draft,
      id: crypto.randomUUID(),
      stage: 'Imported',
      unavailable: false,
      coverAssetId: null,
      assetCount: 0,
    };
    if (await persist([...workspace.shoots, shoot])) {
      newOpen = false;
      section = 'shoots';
      await openShoot(shoot.id);
    }
  }

  async function saveDetails(event: SubmitEvent) {
    event.preventDefault();
    if (active) {
      await persist(workspace.shoots.map((shoot) => (shoot.id === activeId ? { ...shoot, ...details } : shoot)));
    }
  }

  const showRating = (assetId: string, rating: number | null) => {
    photos = photos.map((photo) => (photo.id === assetId ? { ...photo, rating } : photo));
    if (inspecting?.id === assetId) {
      inspecting = { ...inspecting, rating };
    }
  };

  /**
   * Rates photographs at once and saves behind the grid. Requests for one photograph run in order;
   * a failure puts that tile back to what the server last accepted and offers a retry on the tile.
   */
  function rate(ids: string[], rating: number | null) {
    if (!activeId) {
      return;
    }
    const shootId = activeId;
    const current = ratingGeneration;
    message = '';
    for (const assetId of ids) {
      const photo = photos.find(({ id }) => id === assetId);
      if (!photo?.canRate) {
        continue;
      }
      if (!confirmed.has(assetId)) {
        confirmed.set(assetId, photo.rating);
      }
      const mine = (turn.get(assetId) ?? 0) + 1;
      turn.set(assetId, mine);
      showRating(assetId, rating);
      if (Object.hasOwn(ratingFailed, assetId)) {
        ratingFailed = Object.fromEntries(Object.entries(ratingFailed).filter(([id]) => id !== assetId));
      }
      justRated = [...justRated, assetId];
      setTimeout(() => (justRated = justRated.filter((id) => id !== assetId)), DURATION.slow);
      ratingsSaving++;
      const save = async () => {
        try {
          await ratePhoto(shootId, assetId, rating);
          if (!disposed && current === ratingGeneration) {
            confirmed.set(assetId, rating);
          }
        } catch {
          if (!disposed && current === ratingGeneration && turn.get(assetId) === mine) {
            showRating(assetId, confirmed.get(assetId) ?? null);
            ratingFailed = { ...ratingFailed, [assetId]: rating };
          }
        } finally {
          if (!disposed && current === ratingGeneration) {
            ratingsSaving--;
            if (ratingsSaving === 0 && Object.keys(ratingFailed).length === 0) {
              message = $t('frameleaf_photography_ratings_saved');
            }
          }
        }
      };
      queue.set(assetId, (queue.get(assetId) ?? Promise.resolve()).then(save));
    }
  }

  async function inspect(photo: Photo) {
    inspecting = photo;
    versions = null;
    versionError = '';
    const current = ++versionGeneration;
    versionsLoading = true;
    try {
      const saved = await getAssetDevelop({ id: photo.id });
      if (!disposed && current === versionGeneration) {
        versions = saved;
      }
    } catch (error_) {
      if (current === versionGeneration) {
        versionError = failure(error_);
      }
    } finally {
      if (current === versionGeneration) {
        versionsLoading = false;
      }
    }
  }

  /** Makes a photograph the current one: the keys act on it and its details show beside the grid. */
  function choose(photo: Photo) {
    selected = photo.canRate ? [photo.id] : [];
    void inspect(photo);
  }

  /** How many tiles share the first row, so Up and Down move by a row. */
  const columns = () => {
    const tiles = [...(grid?.querySelectorAll<HTMLElement>('.phw-photo') ?? [])];
    return Math.max(1, tiles.filter((tile) => tile.offsetTop === tiles[0]?.offsetTop).length);
  };

  function onCullingKey(event: KeyboardEvent) {
    if (section !== 'shoots' || !active || newOpen || compareOpen || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // Focus inside the grid (a clicked thumbnail, a star) still culls; any other control keeps its keys.
    const inGrid = event.target instanceof HTMLElement && !!event.target.closest('.phw-photo-grid');
    if (!inGrid && typingInto(event.target)) {
      return;
    }
    const currentId = inspecting?.id ?? selected.at(-1);
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      if (visible.length === 0) {
        return;
      }
      const index = visible.findIndex((photo) => photo.id === currentId);
      const step =
        event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowLeft'
            ? -1
            : event.key === 'ArrowDown'
              ? columns()
              : -columns();
      const target = index === -1 ? 0 : index + step;
      const next = visible[target];
      event.preventDefault();
      if (!next) {
        return;
      }
      choose(next);
      void tick().then(() =>
        grid?.querySelector<HTMLElement>(`[data-photo-id="${CSS.escape(next.id)}"] .phw-open-photo`)?.focus(),
      );
    } else if (/^[0-5xX]$/.test(event.key)) {
      const targets = selected.length > 0 ? selected : inspecting?.canRate ? [inspecting.id] : [];
      if (targets.length === 0) {
        return;
      }
      event.preventDefault();
      rate(targets, event.key.toLowerCase() === 'x' ? -1 : event.key === '0' ? null : Number(event.key));
    }
  }

  onMount(() => {
    void reload();
    return onLibraryAccessChange(() => {
      generation++;
      detailGeneration++;
      versionGeneration++;
      resetRatings();
      section = 'shoots';
      workspace = { revision: null, shoots: [] };
      workflowSummaries = [];
      summaryFailed = false;
      albums = [];
      activeId = null;
      photos = [];
      inspecting = null;
      versions = null;
      selected = [];
      compareOpen = false;
      batchOpen = false;
      busy = false;
      newOpen = false;
      draft = emptyDraft();
      details = { name: '', client: '', stage: 'Imported' };
      message = '';
      error = '';
      if (authManager.authenticated) {
        void reload();
      }
    }, authManager.user.id);
  });
  onDestroy(() => {
    disposed = true;
    generation++;
    detailGeneration++;
    versionGeneration++;
    ratingGeneration++;
  });
</script>

<svelte:window onkeydown={onCullingKey} />

<div class="phw">
  <aside class="phw-rail">
    <a class="phw-return" href={Route.photos()}
      ><Icon icon={mdiArrowLeft} size="1rem" aria-hidden={true} />{$t('frameleaf_photography_back_to_library')}</a
    >
    <div class="phw-studio-brand">
      <span class="phw-brand-mark"><Icon icon={mdiCameraIris} size="1.2rem" aria-hidden={true} /></span>
      <div><strong>{authManager.user.name}</strong><small>{$t('frameleaf_photography_workspace')}</small></div>
    </div>
    <nav aria-label={$t('frameleaf_photography_workspace')}>
      <button
        type="button"
        aria-current={section === 'shoots' && !active ? 'page' : undefined}
        disabled={busy}
        onclick={() => {
          const returning = section !== 'shoots';
          closeShoot();
          if (returning) {
            void reload();
          }
        }}><Icon icon={mdiCameraOutline} size="1.2rem" aria-hidden={true} />{$t('frameleaf_photography_shoots')}</button
      >
      <button
        type="button"
        aria-current={section === 'galleries' ? 'page' : undefined}
        disabled={busy}
        onclick={openGalleries}
        ><Icon icon={mdiImageMultipleOutline} size="1.2rem" aria-hidden={true} /><span
          >{$t('frameleaf_photography_galleries')}</span
        >{#if galleryCount}<small class="phw-nav-count">{galleryCount}</small>{/if}</button
      >
      {#each [['website', $t('frameleaf_photography_studio_website'), mdiWeb], ['watermarks', $t('frameleaf_photography_watermarks'), mdiWatermark], ['branding', $t('frameleaf_photography_branding'), mdiPaletteOutline]] as const as [id, label, icon] (id)}
        <button
          type="button"
          aria-current={section === id ? 'page' : undefined}
          disabled={busy}
          onclick={() => (section = id)}><Icon {icon} size="1.2rem" aria-hidden={true} />{label}</button
        >
      {/each}
    </nav>
    <div class="phw-rail-bottom">
      <Icon icon={mdiShieldCheckOutline} size="1.3rem" aria-hidden={true} />
      <p>
        {$t('frameleaf_photography_originals_local')}<small>{$t('frameleaf_photography_originals_local_detail')}</small>
      </p>
      <a href={Route.rawSupport()}
        >{$t('frameleaf_photography_raw_compatibility')}
        <Icon icon={mdiChevronRight} size="1rem" aria-hidden={true} /></a
      >
    </div>
  </aside>
  <div class="phw-workspace">
    <header class="phw-header">
      <div>
        <span class="phw-breadcrumb">{$t('frameleaf_photography')}</span>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div class="phw-header-actions">
        <span class="phw-save">
          <PhotographyStatus
            state={busy || ratingsSaving > 0 ? 'saving' : message ? 'saved' : 'idle'}
            savingLabel={$t('frameleaf_photography_saving')}
            savedLabel={message}
          />
        </span>
        {#if section === 'shoots'}<span class="phw-new-shoot-action" class:in-shoot={!!active}
            ><Button variant="primary" disabled={loading || busy || !!error} onclick={startShoot}
              ><Icon icon={mdiPlus} size="1rem" aria-hidden={true} />{$t('frameleaf_photography_new_shoot')}</Button
            ></span
          >{:else if picksShoot(section) && workspace.shoots.length > 0}<select
            class="phw-shoot-picker"
            aria-label={$t('frameleaf_photography_current_shoot')}
            value={activeId ?? ''}
            disabled={busy}
            onchange={(event) => openShoot(event.currentTarget.value)}
            >{#if !active}<option value="" disabled>{$t('frameleaf_photography_choose_shoot')}</option
              >{/if}{#each workspace.shoots as shoot (shoot.id)}<option value={shoot.id}>{shoot.name}</option
              >{/each}</select
          >{/if}
      </div>
    </header>
    {#if error}<InlineError
        compact
        message={error}
        onRetry={reload}
        retrying={loading}
        retryLabel={$t('frameleaf_photography_reload_shoots')}
      />{/if}
    <main class="phw-scroll" aria-busy={loading} bind:this={scroller}>
      {#if section === 'branding'}<PhotographyBranding
          photoId={samplePhotoId}
          onSaved={() => {
            void reload();
          }}
        />
      {:else if section === 'watermarks'}<PhotographyWatermarks />
      {:else if section === 'website'}<PhotographyWebsite shoots={workspace.shoots} />
      {:else if picksShoot(section)}
        {#if active}{#key `${active.id}:${section}`}<PhotographyWorkflow
              shoot={active}
              panel={section === 'galleries' ? 'publishing' : (section as ShootSection)}
              onSection={openTab}
              onGalleries={() => (section = 'galleries')}
            />{/key}
        {:else if !loading}<div class="phw-empty">
            <h2>{$t('frameleaf_photography_choose_shoot')}</h2>
            <p>{$t('frameleaf_photography_choose_shoot_body')}</p>
            <Button onclick={closeShoot}>{$t('frameleaf_photography_shoots')}</Button>
          </div>{/if}
      {:else if loading}
        <div class="phw-shoot-grid" role="status" aria-label={$t('frameleaf_photography_loading_shoots')}>
          {#each [0, 1, 2] as placeholder (placeholder)}<Skeleton variant="block" height="240px" />{/each}
        </div>
      {:else if active}
        <div class="phw-shoot-top">
          <Button disabled={busy} onclick={closeShoot}
            ><Icon icon={mdiArrowLeft} size={ICON_SIZE.md} aria-hidden={true} />{$t(
              'frameleaf_photography_shoots_all',
            )}</Button
          >
          <div class="phw-stages" aria-label={$t('frameleaf_photography_shoot_progress')}>
            {#each shootStages as stage, index (stage)}<span class:done={index <= shootStages.indexOf(active.stage)}
                ><i>{index + 1}</i>{$t(shootStageKeys[stage])}</span
              >{/each}
          </div>
        </div>
        <PhotographyShootTabs current="photos" onSection={openTab} />
        {#if active.unavailable}<div class="phw-empty">
            <h2>{$t('frameleaf_photography_album_unavailable')}</h2>
            <p>
              {$t('frameleaf_photography_album_unavailable_body')}
            </p>
            <Button
              disabled={busy}
              onclick={() =>
                persist(workspace.shoots.filter(({ id }) => id !== activeId)).then((saved) => {
                  if (saved) {
                    closeShoot();
                  }
                })}>{$t('frameleaf_photography_remove_shoot')}</Button
            >
          </div>
        {:else}<div class="phw-detail-layout">
            <section class="phw-contact-sheet">
              <div class="phw-contact-toolbar">
                <div class="phw-tabs" role="group" aria-label={$t('frameleaf_photography_photo_filter')}>
                  {#each photoFilters as name (name)}<button
                      type="button"
                      aria-pressed={tab === name}
                      onclick={() => {
                        tab = name;
                        selected = [];
                      }}
                      >{photoFilterLabel(name)}<small>{photos.filter((photo) => matches(photo, name)).length}</small
                      ></button
                    >{/each}
                </div>
                {#if active.albumId}<a href={Route.viewAlbum({ id: active.albumId })}
                    >{$t('frameleaf_photography_add_photos_in_album')}</a
                  >{/if}
              </div>
              <div class="phw-selection-tools">
                <label
                  ><input
                    type="checkbox"
                    aria-label={$t('frameleaf_photography_select_all_visible')}
                    disabled={visible.every((photo) => !photo.canRate)}
                    checked={visible.some((photo) => photo.canRate) &&
                      visible.filter((photo) => photo.canRate).every(({ id }) => selected.includes(id))}
                    onchange={(event) =>
                      (selected = event.currentTarget.checked
                        ? visible.filter((photo) => photo.canRate).map(({ id }) => id)
                        : [])}
                  />{selected.length > 0
                    ? $t('frameleaf_photography_selected_count', { values: { count: selected.length } })
                    : $t('frameleaf_photography_select_photos')}</label
                >{#if selected.length}<Button onclick={() => rate(selected, 4)}
                    >{$t('frameleaf_photography_keep')}</Button
                  ><Button onclick={() => rate(selected, -1)}>{$t('frameleaf_photography_reject')}</Button><Button
                    onclick={() => rate(selected, null)}>{$t('frameleaf_photography_clear_rating')}</Button
                  >{/if}
                {#if selected.length === 2}<Button onclick={() => (compareOpen = true)}
                    >{$t('frameleaf_photography_compare')}</Button
                  >{/if}
                {#if selected.length > 1}<Button onclick={() => (batchOpen = !batchOpen)} pressed={batchOpen}
                    >{$t('frameleaf_photography_batch_raw')}</Button
                  >{/if}
              </div>
              <p class="phw-small">
                {$t('frameleaf_photography_culling_hint')}
              </p>
              {#if batchOpen && selected.length > 1}<PhotographyNativeSync {photos} assetIds={selected} />{/if}
              {#if photoError}<InlineError
                  compact
                  message={photoError}
                  retrying={photoLoading}
                  onRetry={() => (photos.length > 0 ? more() : openShoot(active.id))}
                />{/if}
              <div class="phw-photo-grid" bind:this={grid}>
                {#each visible as photo (photo.id)}<article
                    class="phw-photo"
                    class:is-selected={selected.includes(photo.id) || inspecting?.id === photo.id}
                    class:is-rejected={photo.rating === -1}
                    data-photo-id={photo.id}
                  >
                    <div class="phw-photo-image">
                      <button
                        type="button"
                        class="phw-open-photo fl-no-press"
                        aria-label={$t('frameleaf_photography_inspect_photo', { values: { name: photo.fileName } })}
                        aria-current={inspecting?.id === photo.id ? 'true' : undefined}
                        onclick={() => choose(photo)}
                        ><PhotographyThumb src={cover(photo.id)} alt={photo.fileName} /></button
                      ><input
                        class="phw-photo-select"
                        type="checkbox"
                        aria-label={$t('frameleaf_photography_select_photo', { values: { name: photo.fileName } })}
                        disabled={!photo.canRate}
                        checked={selected.includes(photo.id)}
                        onchange={(event) =>
                          (selected = event.currentTarget.checked
                            ? [...selected, photo.id]
                            : selected.filter((id) => id !== photo.id))}
                      /><span class="phw-raw"
                        >{photo.fileName.split('.').at(-1)?.toUpperCase()}{#if photo.stackCount > 1}
                          · {$t('frameleaf_photography_in_stack', { values: { count: photo.stackCount } })}{/if}</span
                      >{#if photo.currentRevisionId}<span class="phw-edited"
                          >{$t('frameleaf_photography_filter_edited')}</span
                        >{/if}
                    </div>
                    <div class="phw-photo-meta">
                      <span title={photo.fileName}>{photo.fileName}</span>
                      <div
                        class="phw-stars"
                        class:is-just-rated={justRated.includes(photo.id)}
                        role="group"
                        aria-label={$t('frameleaf_photography_rating_for', { values: { name: photo.fileName } })}
                      >
                        {#each [1, 2, 3, 4, 5] as rating (rating)}<button
                            type="button"
                            class="fl-no-press"
                            aria-label={$t('frameleaf_photography_rate_stars', {
                              values: { count: rating, name: photo.fileName },
                            })}
                            aria-pressed={photo.rating === rating}
                            disabled={!photo.canRate}
                            onclick={() => rate([photo.id], photo.rating === rating ? null : rating)}
                            ><Icon
                              icon={(photo.rating ?? 0) >= rating ? mdiStar : mdiStarOutline}
                              size="0.875rem"
                              aria-hidden={true}
                            /></button
                          >{/each}<button
                          type="button"
                          class="phw-reject fl-no-press"
                          aria-label={photo.rating === -1
                            ? $t('frameleaf_photography_restore_photo', { values: { name: photo.fileName } })
                            : $t('frameleaf_photography_reject_photo', { values: { name: photo.fileName } })}
                          aria-pressed={photo.rating === -1}
                          disabled={!photo.canRate}
                          onclick={() => rate([photo.id], photo.rating === -1 ? null : -1)}
                          ><Icon
                            icon={photo.rating === -1 ? mdiRestore : mdiCloseCircleOutline}
                            size="0.875rem"
                            aria-hidden={true}
                          /></button
                        >
                      </div>
                      {#if Object.hasOwn(ratingFailed, photo.id)}
                        <p class="phw-rating-failed" role="alert">
                          {$t('frameleaf_photography_rating_not_saved')}
                          <button type="button" onclick={() => rate([photo.id], ratingFailed[photo.id])}
                            >{$t('frameleaf_error_retry')}</button
                          >
                        </p>
                      {/if}
                    </div>
                  </article>{/each}
              </div>
              {#if photoLoading}<div
                  class="phw-photo-grid"
                  role="status"
                  aria-label={$t('frameleaf_photography_loading_photos')}
                >
                  {#each [0, 1, 2, 3] as placeholder (placeholder)}<Skeleton variant="tile" />{/each}
                </div>{:else if visible.length === 0 && !photoError}<div class="phw-empty">
                  <Icon icon={mdiCameraOutline} size="2rem" aria-hidden={true} />
                  <h2>
                    {photos.length === 0
                      ? $t('frameleaf_photography_shoot_ready')
                      : tab === 'edited'
                        ? $t('frameleaf_photography_no_edited_photos')
                        : $t('frameleaf_photography_no_selected_photos')}
                  </h2>
                  <p>
                    {photos.length > 0
                      ? $t('frameleaf_photography_no_filtered_body')
                      : $t('frameleaf_photography_shoot_ready_body')}
                  </p>
                  {#if active.albumId}<a href={Route.viewAlbum({ id: active.albumId })}
                      >{$t('frameleaf_photography_open_album')}</a
                    >{/if}
                </div>{/if}
              {#if nextCursor}<Button disabled={photoLoading} onclick={more}
                  >{$t('frameleaf_photography_load_more_photos')}</Button
                >{/if}
            </section>
            <aside class="phw-inspector">
              <div class="phw-inspector-cover">
                {#if inspecting || active.coverAssetId}<PhotographyThumb
                    src={cover(inspecting?.id ?? active.coverAssetId!)}
                    alt={inspecting?.fileName ?? active.name}
                    loading="eager"
                  />{/if}
              </div>
              <div class="phw-inspector-body">
                <h2>{$t('frameleaf_photography_shoot_details')}</h2>
                <form onsubmit={saveDetails}>
                  <label class="phw-field"
                    ><span>{$t('frameleaf_photography_shoot_name')}</span><input
                      required
                      maxlength="200"
                      bind:value={details.name}
                      disabled={busy}
                    /></label
                  ><label class="phw-field"
                    ><span>{$t('frameleaf_photography_client')}</span><input
                      required
                      maxlength="200"
                      bind:value={details.client}
                      disabled={busy}
                    /></label
                  ><label class="phw-field"
                    ><span>{$t('frameleaf_photography_stage')}</span><select bind:value={details.stage} disabled={busy}
                      >{#each shootStages as stage (stage)}<option value={stage}>{$t(shootStageKeys[stage])}</option
                        >{/each}</select
                    ></label
                  ><Button type="submit" disabled={busy || !!error}>{$t('frameleaf_photography_save_details')}</Button>
                </form>
                <dl class="phw-stats">
                  <div>
                    <dt>{$t('frameleaf_photography_stat_loaded')}</dt>
                    <dd>{photos.length}</dd>
                  </div>
                  <div>
                    <dt>{$t('frameleaf_photography_stat_kept')}</dt>
                    <dd>{photos.filter((photo) => (photo.rating ?? 0) >= 4).length}</dd>
                  </div>
                  <div>
                    <dt>{$t('frameleaf_photography_filter_edited')}</dt>
                    <dd>{photos.filter((photo) => photo.currentRevisionId && photo.rating !== -1).length}</dd>
                  </div>
                  <div>
                    <dt>{$t('frameleaf_photography_stat_rejected')}</dt>
                    <dd>{photos.filter((photo) => photo.rating === -1).length}</dd>
                  </div>
                </dl>
                {#if rawPhotos.length > 0}<a
                    class="phw-raw-editor fl-control primary"
                    href={Route.photographyDevelop({
                      shoot: active.id,
                      photo: inspecting && isRawName(inspecting.fileName) ? inspecting.id : undefined,
                      only: chosenRaw.length > 0 ? chosenRaw.join(',') : undefined,
                    })}
                    ><Icon icon={mdiTune} size="1rem" aria-hidden={true} />{chosenRaw.length > 0
                      ? $t('frameleaf_photography_open_raw_editor_count', { values: { count: chosenRaw.length } })
                      : $t('frameleaf_photography_open_raw_editor')}</a
                  >{:else if photos.length > 0}<p class="phw-small">{$t('frameleaf_photography_no_raw_photos')}</p>{/if}
                {#if inspecting}<h3>{inspecting.fileName}</h3>
                  {#if active.albumId}<a
                      href={Route.viewAlbumAsset({ albumId: active.albumId, assetId: inspecting.id })}
                      >{$t('frameleaf_photography_open_photo_editor')}</a
                    >{/if}{#if versionsLoading}<p role="status">{$t('frameleaf_photography_loading_versions')}</p>
                  {:else if versionError}<InlineError
                      compact
                      message={versionError}
                      onRetry={() => inspect(inspecting!)}
                    />{:else if versions}<h3>{$t('frameleaf_photography_saved_versions')}</h3>
                    {#if versions.revisions.length === 0}<p>
                        {$t('frameleaf_photography_no_versions')}
                      </p>{/if}{#each versions.revisions as version (version.revision)}<p>
                        {version.label ??
                          $t('frameleaf_photography_version_number', {
                            values: { number: version.revision },
                          })}{version.isCurrent ? ` · ${$t('frameleaf_photography_version_current')}` : ''}
                      </p>{/each}{/if}{/if}
                <p class="phw-small">
                  {$t('frameleaf_photography_inspector_hint')}
                </p>
              </div>
            </aside>
          </div>{/if}
      {:else if !error}
        {#if workspace.shoots.length > 0}
          <div class="phx-metrics">
            <div>
              <small>{$t('frameleaf_photography_metric_active')}</small><strong>{activeShoots}</strong>
            </div>
            <div>
              <small>{$t('frameleaf_photography_metric_awaiting')}</small><strong
                >{summaryFailed ? '—' : awaitingSelections}</strong
              >
            </div>
            <div>
              <small>{$t('frameleaf_photography_metric_editing_queue')}</small><strong
                >{summaryFailed ? '—' : editingQueue}</strong
              >
            </div>
            {#if outstanding}<div>
                <small
                  >{outstanding.length === 1
                    ? $t('frameleaf_photography_metric_outstanding_currency', {
                        values: { currency: outstanding[0][0] },
                      })
                    : $t('frameleaf_photography_metric_outstanding')}</small
                ><strong
                  >{outstanding
                    .map(([currency, amount]) => money(amount, currency, outstanding.length === 1))
                    .join(' · ')}</strong
                >
              </div>{:else}<div>
                <small>{$t('frameleaf_photography_metric_unpaid')}</small><strong
                  >{summaryFailed ? '—' : workflowSummaries.reduce((total, row) => total + row.unpaidOrders, 0)}</strong
                >
              </div>{/if}
          </div>
          {#if summaryFailed}<InlineError
              compact
              message={$t('frameleaf_photography_summary_failed')}
              onRetry={reload}
              retrying={loading}
            />{/if}
          {#if nextSteps.length}<div class="phx-action-list">
              <div>
                <span class="phx-eyebrow">{$t('frameleaf_photography_next_steps_eyebrow')}</span>
                <h2>{$t('frameleaf_photography_next_steps_title')}</h2>
              </div>
              <div>
                {#each nextSteps as { shoot, action } (shoot.id)}<button
                    type="button"
                    disabled={busy}
                    onclick={() => openShootAt(shoot.id, action.section)}
                    ><Icon icon={action.icon} size="1.2rem" aria-hidden={true} /><span
                      ><strong>{shoot.name}</strong><small>{action.label}</small></span
                    ><Icon icon={mdiChevronRight} size="1rem" aria-hidden={true} /></button
                  >{/each}
              </div>
            </div>{/if}
          <div class="phw-tabs phd-project-filters" role="group" aria-label={$t('frameleaf_photography_shoot_status')}>
            {#each shootFilters as filter (filter)}<button
                type="button"
                aria-pressed={shootFilter === filter}
                onclick={() => (shootFilter = filter)}>{shootFilterLabel(filter)}</button
              >{/each}
          </div>
          <div class="phw-list-tools">
            <label class="phw-search"
              ><Icon icon={mdiMagnify} size="1.2rem" aria-hidden={true} /><input
                aria-label={$t('frameleaf_photography_search_shoots')}
                placeholder={$t('frameleaf_photography_search_shoots_placeholder')}
                bind:value={search}
              /></label
            ><select aria-label={$t('frameleaf_photography_sort_shoots')} bind:value={sort}
              ><option value="date">{$t('frameleaf_photography_sort_newest')}</option><option value="name"
                >{$t('frameleaf_photography_shoot_name')}</option
              ></select
            ><span>{$t('frameleaf_photography_shoot_count', { values: { count: listing.length } })}</span>
          </div>
        {/if}
        <div class="phw-shoot-grid">
          {#each listing as shoot (shoot.id)}{@const action = shoot.unavailable ? null : nextAction(shoot)}<button
              type="button"
              class="phw-shoot-card"
              onclick={() => openShoot(shoot.id)}
              ><div class="phw-shoot-image">
                {#if shoot.coverAssetId}<PhotographyThumb src={cover(shoot.coverAssetId)} />{:else}<Icon
                    icon={mdiCameraOutline}
                    size="3rem"
                    aria-hidden={true}
                  />{/if}<span class="phw-status"
                  >{shoot.unavailable ? $t('frameleaf_photography_unavailable') : $t(shootStageKeys[shoot.stage])}</span
                >
              </div>
              <div class="phw-shoot-text">
                <strong>{shoot.name}</strong><span>{shoot.client}</span>
                {#if action}<small class="phx-card-action"
                    ><Icon icon={action.icon} size="0.875rem" aria-hidden={true} />{action.label}</small
                  >{/if}
                <footer>
                  <time datetime={shoot.date}>{dateLabel(shoot.date)}</time><span
                    >{shoot.assetCount === null
                      ? '—'
                      : $t('frameleaf_photography_photo_count', { values: { count: shoot.assetCount } })}
                    <Icon icon={mdiChevronRight} size="0.875rem" aria-hidden={true} /></span
                  >
                </footer>
              </div></button
            >{/each}
        </div>
        {#if listing.length === 0}<div class="phw-empty">
            <Icon icon={mdiCameraOutline} size="2rem" aria-hidden={true} />
            <h2>
              {workspace.shoots.length > 0
                ? $t('frameleaf_photography_no_shoots_match')
                : $t('frameleaf_photography_shoots_start')}
            </h2>
            <p>
              {workspace.shoots.length > 0
                ? $t('frameleaf_photography_no_shoots_match_body')
                : $t('frameleaf_photography_shoots_start_body')}
            </p>
            {#if search}<Button onclick={() => (search = '')}>{$t('frameleaf_photography_clear_search')}</Button
              >{:else if workspace.shoots.length === 0}<Button variant="primary" disabled={busy} onclick={startShoot}
                ><Icon icon={mdiPlus} size="1rem" aria-hidden={true} />{$t('frameleaf_photography_new_shoot')}</Button
              >{/if}
          </div>{/if}
        <div class="phw-list-footer">{$t('frameleaf_photography_list_footer')}</div>
      {/if}
    </main>
  </div>
  <Dialog title={$t('frameleaf_photography_compare_title')} closeLabel={$t('close')} bind:open={compareOpen} wide>
    <div class="phd-owner-compare">
      {#each photos.filter((photo) => selected.includes(photo.id)).slice(0, 2) as photo (photo.id)}
        <figure>
          <img src={getAssetMediaUrl({ id: photo.id, size: AssetMediaSize.Preview })} alt={photo.fileName} />
          <figcaption>
            {photo.fileName}{#if active?.albumId}<a
                href={Route.viewAlbumAsset({ albumId: active.albumId, assetId: photo.id })}
                >{$t('frameleaf_photography_open_photo_editor')}</a
              >{/if}
          </figcaption>
        </figure>
      {/each}
    </div>
  </Dialog>

  <Dialog
    title={$t('frameleaf_photography_new_shoot')}
    closeLabel={$t('close')}
    bind:open={newOpen}
    onRequestClose={() => {
      if (!busy) {
        newOpen = false;
      }
    }}
  >
    <form class="phw-new-shoot" onsubmit={create}>
      <label class="phw-field"
        ><span>{$t('frameleaf_photography_shoot_name')}</span><input
          required
          data-initial-focus
          maxlength="200"
          bind:value={draft.name}
          disabled={busy}
        /></label
      >
      <label class="phw-field"
        ><span>{$t('frameleaf_photography_client')}</span><input
          required
          maxlength="200"
          bind:value={draft.client}
          disabled={busy}
        /></label
      >
      <label class="phw-field"
        ><span>{$t('frameleaf_photography_shoot_type')}</span><select bind:value={draft.type} disabled={busy}
          >{#each shootTypes as type (type)}<option value={type}>{$t(shootTypeKeys[type])}</option>{/each}</select
        ></label
      >
      <label class="phw-field"
        ><span>{$t('frameleaf_photography_shoot_date')}</span><input
          required
          type="date"
          bind:value={draft.date}
          disabled={busy}
        /></label
      >
      <label class="phw-field"
        ><span>{$t('frameleaf_photography_source_album')}</span><select
          required
          bind:value={draft.albumId}
          disabled={busy}
          ><option value="" disabled>{$t('frameleaf_photography_choose_album')}</option
          >{#each availableAlbums as album (album.id)}<option value={album.id}>{album.albumName}</option>{/each}</select
        ></label
      >
      <p class="phw-small">
        {$t('frameleaf_photography_new_shoot_note')}
      </p>
      {#if availableAlbums.length === 0}<p>{$t('frameleaf_photography_no_albums')}</p>
        <a href={Route.newAlbum({ kind: 'album' })}>{$t('frameleaf_photography_create_album')}</a>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
      <div class="phw-dialog-actions">
        <Button disabled={busy} onclick={() => (newOpen = false)}>{$t('cancel')}</Button><Button
          type="submit"
          variant="primary"
          disabled={busy || !draft.albumId}
          >{busy ? $t('frameleaf_photography_saving') : $t('frameleaf_photography_create_shoot')}</Button
        >
      </div>
    </form>
  </Dialog>
</div>
