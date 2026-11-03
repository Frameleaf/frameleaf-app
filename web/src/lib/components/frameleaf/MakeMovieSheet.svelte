<script lang="ts">
  /**
   * Make a movie (FL-561): the approved mock's sheet (`MakeMovieSheet` in the prototype's
   * `StudioUpgrades.jsx`, styles `studio-upgrades.css` `.flu-*`). Three choices (length, music,
   * title), then progress, then the movie with "Try another version" and "Edit in Studio".
   *
   * The server makes the movie (`POST /studio/movies`): it picks the moments, makes the music or reads
   * the song, cuts on the beat and saves a Studio project. The sheet follows the job, which Activity
   * also shows, so closing the sheet never stops it.
   */
  import {
    AssetMediaSize,
    cancelMediaOperation,
    createStudioMovie,
    getMlCapabilities,
    getStudioMovie,
    getStudioMovieSongs,
    MediaOperationStatus,
    StudioMovieStep,
    type StudioMovieDto,
    type StudioMovieResultDto,
    type StudioMovieSongDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiCheckCircle,
    mdiCircleOutline,
    mdiCreation,
    mdiImageFilterHdr,
    mdiInformationOutline,
    mdiMovieEditOutline,
    mdiMovieOpenPlayOutline,
    mdiMusicNoteOutline,
    mdiPause,
    mdiPlay,
    mdiProgressClock,
    mdiShuffleVariant,
    mdiCampfire,
    mdiWeatherSunsetDown,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
  import { goto } from '$app/navigation';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    isBarBeat,
    moodLabel,
    movieLengths,
    movieMoods,
    movieRequest,
    movieStepLabels,
    movieStepOrder,
    movieStepsDone,
    percentOf,
    shortTimecode,
    shotAt,
    type MakeMovieSource,
    type MovieLength,
    type MovieMood,
  } from '$lib/frameleaf/studio/make-movie';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl, getStudioProjectImportUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';

  let {
    open = $bindable(false),
    source,
    onClosed,
  }: {
    open?: boolean;
    source: MakeMovieSource;
    onClosed?: () => void;
  } = $props();

  const POLL_MS = 1500;
  const moodIcons: Record<MovieMood, string> = {
    calm: mdiWeatherSunsetDown,
    warm: mdiCampfire,
    upbeat: mdiWhiteBalanceSunny,
    big: mdiImageFilterHdr,
  };

  let step = $state<'choose' | 'progress' | 'result' | 'failed'>('choose');
  let lengthSeconds = $state<MovieLength>(60);
  let music = $state<'generated' | 'song'>('generated');
  let mood = $state<MovieMood>('calm');
  let songId = $state<string | null>(null);
  let songs = $state<StudioMovieSongDto[] | null>(null);
  let songQuery = $state('');
  let title = $state('');
  let canMakeMusic = $state(true);
  let job = $state<StudioMovieDto | null>(null);
  let result = $state<StudioMovieResultDto | null>(null);
  let starting = $state(false);
  let poll: ReturnType<typeof setTimeout> | undefined;
  const fieldId = $props.id();

  const stopPolling = () => {
    clearTimeout(poll);
    poll = undefined;
  };
  onDestroy(stopPolling);

  // Every opening starts from the choices, unless a movie is still being made.
  $effect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    untrack(() => {
      if (step !== 'progress') {
        step = 'choose';
        result = null;
        job = null;
      } else if (job) {
        void follow(job.id);
      }
      void getMlCapabilities()
        .then(({ studio }) => {
          canMakeMusic = studio.generationWorker === true;
          if (!canMakeMusic && music === 'generated') {
            music = 'song';
          }
        })
        .catch(() => (canMakeMusic = false));
    });
  });

  let songSearch: ReturnType<typeof setTimeout> | undefined;
  const fetchSongs = async (query: string) => {
    try {
      songs = await getStudioMovieSongs({ query: query.trim() || undefined });
      if (!songId || songs.every((song) => song.id !== songId)) {
        songId = songs[0]?.id ?? null;
      }
    } catch (error) {
      songs = [];
      handleError(error, $t('frameleaf_movie_failed'));
    }
  };
  const loadSongs = (query: string) => {
    clearTimeout(songSearch);
    songSearch = setTimeout(() => void fetchSongs(query), 200);
  };
  $effect(() => {
    if (open && music === 'song' && songs === null) {
      loadSongs('');
    }
  });

  const sourceSummary = $derived.by(() => {
    if (source.kind !== 'selection') {
      return $t('frameleaf_movie_source_items', { values: { count: source.itemCount } });
    }
    const photos = $t('frameleaf_movie_source_photos', { values: { count: source.photoCount } });
    const videos = $t('frameleaf_movie_source_videos', { values: { count: source.videoCount } });
    if (source.photoCount && source.videoCount) {
      return $t('frameleaf_movie_source_photos_videos', { values: { photos, videos } });
    }
    return source.videoCount ? videos : photos;
  });
  const itemCount = $derived(source.kind === 'selection' ? source.photoCount + source.videoCount : source.itemCount);
  const previews = $derived((source.previewIds ?? []).slice(0, 3));
  const canStart = $derived(!starting && itemCount > 0 && (music === 'generated' ? canMakeMusic : songId !== null));
  const labels = $derived(movieStepLabels(job ? (music === 'song' ? 'song' : 'generated') : music));
  const done = $derived(movieStepsDone(job?.step ?? 'moments', job?.status === MediaOperationStatus.Completed));

  const follow = async (id: string) => {
    stopPolling();
    try {
      const next = await getStudioMovie({ id });
      job = next;
      if (next.status === MediaOperationStatus.Completed && next.result) {
        result = next.result;
        step = 'result';
        return;
      }
      if ([MediaOperationStatus.Failed, MediaOperationStatus.Cancelled].includes(next.status)) {
        step = next.status === MediaOperationStatus.Cancelled ? 'choose' : 'failed';
        return;
      }
    } catch (error) {
      handleError(error, $t('frameleaf_movie_failed'));
    }
    if (open) {
      poll = setTimeout(() => void follow(id), POLL_MS);
    }
  };

  const start = async (previousId?: string) => {
    if (starting) {
      return;
    }
    starting = true;
    try {
      const queued = await createStudioMovie({
        studioMovieCreateDto: movieRequest(source, {
          lengthSeconds,
          music,
          mood,
          songAssetId: songId,
          title,
          previousId,
        }),
      });
      job = {
        id: queued.id,
        status: queued.status,
        step: StudioMovieStep.Moments,
        progress: 0,
        error: null,
        result: null,
      };
      step = 'progress';
      void follow(queued.id);
    } catch (error) {
      handleError(error, $t('frameleaf_movie_failed'));
    } finally {
      starting = false;
    }
  };

  const another = () => {
    if (!result || !job) {
      return;
    }
    toastManager.primary($t('frameleaf_movie_another_notice'));
    void start(job.id);
  };

  const cancel = async () => {
    stopPolling();
    const id = job?.id;
    step = 'choose';
    job = null;
    if (id) {
      try {
        await cancelMediaOperation({ id });
      } catch (error) {
        handleError(error, $t('frameleaf_movie_failed'));
      }
    }
  };

  const edit = async () => {
    if (!result) {
      return;
    }
    open = false;
    await goto(Route.studio({ projectId: result.projectId }));
  };

  /* The looping preview ---------------------------------------------- */

  let time = $state(0);
  let playing = $state(true);
  let audio = $state<HTMLAudioElement>();
  let frame: number | undefined;
  $effect(() => {
    const player = audio;
    if (step !== 'result' || !result || !playing) {
      player?.pause();
      return;
    }
    const length = result.lengthSeconds;
    const from = untrack(() => time);
    let started = performance.now() - from * 1000;
    if (player) {
      player.currentTime = from;
      // Browsers may refuse sound before the person interacts; the picture plays either way.
      void player.play().catch(() => {});
    }
    const tick = () => {
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed >= length) {
        started = performance.now();
        if (player) {
          player.currentTime = 0;
        }
      }
      time = ((performance.now() - started) / 1000) % length;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  });

  const shot = $derived(result ? shotAt(result.shots, time) : undefined);
  const shotIndex = $derived(result && shot ? result.shots.indexOf(shot) : 0);
  const shotProgress = $derived(shot ? (time - shot.start) / Math.max(0.01, shot.end - shot.start) : 0);
  const showsTitle = $derived(result ? time >= 0.4 && time < Math.min(4.5, (result.bars[2] ?? 4.9) - 0.4) : false);
  const beat = $derived(result && result.bpm > 0 ? 60 / result.bpm : 1);
  const pulse = $derived(1 - (time % beat) / beat);
  const lengthText = (seconds: number) =>
    seconds < 55
      ? $t('frameleaf_movie_length_seconds', { values: { count: Math.round(seconds) } })
      : $t('frameleaf_movie_length_minutes', { values: { count: Math.round(seconds / 60) } });
  const thumbnail = (id: string, size = AssetMediaSize.Thumbnail) => getAssetMediaUrl({ id, size });
</script>

<Dialog
  bind:open
  title={step === 'result' ? $t('frameleaf_movie_ready') : $t('frameleaf_movie_title')}
  closeLabel={$t('close')}
  size={step === 'result' ? 'medium' : 'default'}
  {onClosed}
>
  {#if step === 'choose'}
    <div class="sheet" data-testid="make-movie-sheet">
      <div class="source">
        {#if previews.length > 0}
          <span class="stack" aria-hidden="true">
            {#each previews as id (id)}
              <img src={thumbnail(id)} alt="" />
            {/each}
          </span>
        {/if}
        <div>
          <b>{source.name}</b>
          <span class="muted">{sourceSummary} · {$t('frameleaf_movie_source_note')}</span>
        </div>
      </div>

      <fieldset class="group">
        <legend>{$t('frameleaf_movie_length')}</legend>
        <div class="segmented" role="radiogroup" aria-label={$t('frameleaf_movie_length')}>
          {#each movieLengths as item (item.seconds)}
            <button
              type="button"
              role="radio"
              aria-checked={lengthSeconds === item.seconds}
              class:is-on={lengthSeconds === item.seconds}
              onclick={() => (lengthSeconds = item.seconds)}>{$t(item.label)}</button
            >
          {/each}
        </div>
      </fieldset>

      <fieldset class="group">
        <legend>{$t('frameleaf_movie_music')}</legend>
        <div class="choices" role="radiogroup" aria-label={$t('frameleaf_movie_music')}>
          <button
            type="button"
            role="radio"
            class="choice"
            class:is-on={music === 'generated'}
            aria-checked={music === 'generated'}
            disabled={!canMakeMusic}
            onclick={() => (music = 'generated')}
          >
            <Icon icon={mdiCreation} size="20" aria-hidden={true} />
            <span>
              <b>{$t('frameleaf_movie_music_generated')}</b>
              <small>{$t('frameleaf_movie_music_generated_note')}</small>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            class="choice"
            class:is-on={music === 'song'}
            aria-checked={music === 'song'}
            onclick={() => (music = 'song')}
          >
            <Icon icon={mdiMusicNoteOutline} size="20" aria-hidden={true} />
            <span>
              <b>{$t('frameleaf_movie_music_song')}</b>
              <small>{$t('frameleaf_movie_music_song_note')}</small>
            </span>
          </button>
        </div>
        {#if !canMakeMusic}
          <p class="note">{$t('frameleaf_movie_music_unavailable')}</p>
        {/if}
        {#if music === 'generated'}
          <div class="moods" role="radiogroup" aria-label={$t('frameleaf_movie_mood')}>
            {#each movieMoods as item (item.id)}
              <button
                type="button"
                role="radio"
                class="mood"
                class:is-on={mood === item.id}
                aria-checked={mood === item.id}
                onclick={() => (mood = item.id)}
              >
                <Icon icon={moodIcons[item.id]} size="18" aria-hidden={true} />
                <b>{$t(item.label)}</b>
                <small>{$t(item.note)}</small>
              </button>
            {/each}
          </div>
        {:else}
          <input
            class="search"
            type="search"
            placeholder={$t('frameleaf_movie_song_search')}
            aria-label={$t('frameleaf_movie_song_search')}
            bind:value={songQuery}
            oninput={() => loadSongs(songQuery)}
          />
          {#if songs === null}
            <p class="note">{$t('frameleaf_movie_songs_loading')}</p>
          {:else if songs.length === 0}
            <p class="note">{$t('frameleaf_movie_songs_empty')}</p>
          {:else}
            <ul class="songs" role="radiogroup" aria-label={$t('frameleaf_movie_song')}>
              {#each songs as song (song.id)}
                <li>
                  <button
                    type="button"
                    role="radio"
                    class="song"
                    class:is-on={songId === song.id}
                    aria-checked={songId === song.id}
                    onclick={() => (songId = song.id)}
                  >
                    <Icon
                      icon={songId === song.id ? mdiCheckCircle : mdiMusicNoteOutline}
                      size="18"
                      aria-hidden={true}
                    />
                    <span>
                      <b>{song.name}</b>
                      <small
                        >{song.kind === 'video'
                          ? $t('frameleaf_movie_song_video')
                          : $t('frameleaf_movie_song_audio')}</small
                      >
                    </span>
                    <span class="muted">{shortTimecode(song.durationSeconds)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </fieldset>

      <label class="field" for="{fieldId}-title">
        <span>{$t('frameleaf_movie_title_field')}</span>
        <input id="{fieldId}-title" bind:value={title} maxlength={80} placeholder={source.name} />
      </label>
      <p class="note">
        <Icon icon={mdiInformationOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_movie_note')}
      </p>
    </div>
  {:else if step === 'progress'}
    <div class="progress" role="status" aria-live="polite">
      <progress
        max={movieStepOrder.length}
        value={Math.min(done + 0.5, movieStepOrder.length)}
        aria-label={$t('frameleaf_movie_progress_label')}
      ></progress>
      <ol class="steps">
        {#each movieStepOrder as id, index (id)}
          <li class:is-done={index < done} class:is-now={index === done}>
            <Icon
              icon={index < done ? mdiCheckCircle : index === done ? mdiProgressClock : mdiCircleOutline}
              size="18"
              aria-hidden={true}
            />
            <span>
              {index < done
                ? $t(labels[id].done)
                : $t(labels[id].now, { values: { mood: $t(moodLabel(mood)).toLocaleLowerCase() } })}
            </span>
          </li>
        {/each}
      </ol>
      <p class="note">{$t('frameleaf_movie_progress_note')}</p>
    </div>
  {:else if step === 'failed'}
    <div class="progress" role="alert">
      <p class="error">{job?.error ?? $t('frameleaf_movie_failed')}</p>
    </div>
  {:else if result}
    <div class="result">
      <div class="preview">
        <div class="stage">
          {#if shot}
            {#key shot.assetId + shot.start}
              <img
                src={thumbnail(shot.assetId, AssetMediaSize.Preview)}
                alt=""
                style:transform="scale({1.04 + shotProgress * 0.08}) translateX({(shotProgress - 0.5) *
                  (shotIndex % 2 ? 2 : -2)}%)"
              />
            {/key}
          {/if}
          {#if showsTitle}
            <span class="title">{result.title}</span>
          {/if}
          <span class="beat" style:opacity={0.25 + pulse * 0.6} aria-hidden="true"></span>
          <button
            type="button"
            class="play"
            aria-label={playing ? $t('frameleaf_movie_preview_pause') : $t('frameleaf_movie_preview_play')}
            onclick={() => (playing = !playing)}
          >
            <Icon icon={playing ? mdiPause : mdiPlay} size="22" aria-hidden={true} />
          </button>
          <span class="time">{shortTimecode(time)} / {shortTimecode(result.lengthSeconds)}</span>
          <audio
            bind:this={audio}
            src={getStudioProjectImportUrl(result.projectId, result.musicImportId)}
            preload="none"
          ></audio>
        </div>
        <div class="beatstrip" aria-label={$t('frameleaf_movie_beatstrip', { values: { count: result.shots.length } })}>
          <div class="shots">
            {#each result.shots as item, index (index)}
              <span
                class="shot"
                style:left="{percentOf(item.start, result.lengthSeconds)}%"
                style:width="{percentOf(item.end - item.start, result.lengthSeconds)}%"
              >
                <img src={thumbnail(item.assetId)} alt="" />
              </span>
            {/each}
            <span class="head" style:left="{percentOf(time, result.lengthSeconds)}%" aria-hidden="true"></span>
          </div>
          <div class="beats" aria-hidden="true">
            {#each result.beats as item (item)}
              <i class:is-bar={isBarBeat(item, result.bars)} style:left="{percentOf(item, result.lengthSeconds)}%"></i>
            {/each}
          </div>
        </div>
      </div>
      <dl class="facts">
        <div>
          <dt>{$t('frameleaf_movie_fact_length')}</dt>
          <dd>{lengthText(result.lengthSeconds)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_movie_fact_shots')}</dt>
          <dd>{$t('frameleaf_movie_fact_shots_value', { values: { count: result.shots.length } })}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_movie_fact_music')}</dt>
          <dd>
            {result.music === 'song'
              ? result.musicName
              : $t('frameleaf_movie_fact_music_generated', { values: { mood: $t(moodLabel(result.mood)) } })}
          </dd>
        </div>
        <div>
          <dt>{$t('frameleaf_movie_fact_version')}</dt>
          <dd>{result.version}</dd>
        </div>
      </dl>
    </div>
  {/if}

  {#snippet actions()}
    {#if step === 'choose'}
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" initialFocus disabled={!canStart} onclick={() => void start()}>
        <Icon icon={mdiMovieOpenPlayOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_movie_start')}
      </Button>
    {:else if step === 'progress'}
      <Button onclick={() => void cancel()}>{$t('cancel')}</Button>
    {:else if step === 'failed'}
      <Button onclick={() => (step = 'choose')}>{$t('frameleaf_movie_back')}</Button>
    {:else}
      <Button disabled={starting} onclick={another}>
        <Icon icon={mdiShuffleVariant} size="16" aria-hidden={true} />
        {$t('frameleaf_movie_try_another')}
      </Button>
      <Button variant="primary" initialFocus onclick={() => void edit()}>
        <Icon icon={mdiMovieEditOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_movie_edit')}
      </Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  /* studio-upgrades.css `.flu-*` (approved mock FL-561), shared tokens only; gaps 8 / 12 / 24. */
  .sheet {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .source {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .source > div {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .muted {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stack {
    position: relative;
    width: 76px;
    height: 56px;
    flex-shrink: 0;
  }
  .stack img {
    position: absolute;
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: var(--fl-radius-control);
    border: 2px solid var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
  }
  .stack img:nth-child(1) {
    left: 0;
    transform: rotate(-6deg);
  }
  .stack img:nth-child(2) {
    left: 10px;
    transform: rotate(3deg);
  }
  .stack img:nth-child(3) {
    left: 20px;
  }
  .group {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 12px;
    font-size: var(--fl-font-micro);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fl-muted);
    font-weight: 600;
  }
  .segmented {
    display: flex;
    width: 100%;
    padding: 3px;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .segmented button {
    flex: 1;
    min-height: 36px;
    font-size: 13px;
    border: 0;
    border-radius: calc(var(--fl-radius-control) - 2px);
    background: transparent;
    color: var(--fl-text);
  }
  .segmented button.is-on {
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
    color: var(--fl-accent);
    font-weight: 600;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .choice,
  .mood,
  .song {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    text-align: start;
  }
  .choice.is-on,
  .mood.is-on,
  .song.is-on {
    border-color: var(--fl-accent);
    box-shadow: 0 0 0 1px var(--fl-accent);
  }
  .choice:disabled {
    opacity: 0.5;
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px;
  }
  .choice > span,
  .song > span {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .moods {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .mood {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: 12px;
    row-gap: 2px;
    align-items: center;
    padding: 10px 14px;
  }
  .mood :global(svg) {
    grid-row: span 2;
    color: var(--fl-muted);
  }
  .mood.is-on :global(svg),
  .song.is-on :global(svg) {
    color: var(--fl-accent);
  }
  .search,
  .field input {
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
    font: inherit;
  }
  .songs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 240px;
    overflow-y: auto;
  }
  .song {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
  }
  .song > span:nth-of-type(1) {
    flex: 1;
  }
  .song b {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .note {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
  }

  .progress {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 8px 0;
  }
  .progress progress {
    width: 100%;
    height: 6px;
    accent-color: var(--fl-accent);
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--fl-muted);
    font-size: 14px;
  }
  .steps li.is-now {
    color: var(--fl-text);
    font-weight: 600;
  }
  .steps li.is-now :global(svg) {
    color: var(--fl-accent);
  }
  .steps li.is-done {
    color: var(--fl-text);
  }
  .steps li.is-done :global(svg) {
    color: var(--fl-success, var(--fl-accent));
  }

  .result {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    gap: 24px;
    align-items: start;
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .stage {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: var(--fl-radius-card);
    overflow: hidden;
    background: #000;
  }
  .stage img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    animation: fade 360ms ease;
  }
  @keyframes fade {
    from {
      opacity: 0.2;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage img {
      animation: none;
      transform: none !important;
    }
  }
  .title {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    color: #fff;
    font:
      600 clamp(20px, 3.4vw, 34px) / 1.2 Georgia,
      'Times New Roman',
      serif;
    text-shadow: 0 2px 18px #000a;
  }
  .beat {
    position: absolute;
    right: 16px;
    top: 16px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #fff;
  }
  .play {
    position: absolute;
    left: 16px;
    bottom: 16px;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0008;
    color: #fff;
    backdrop-filter: blur(8px);
  }
  .time {
    position: absolute;
    right: 16px;
    bottom: 16px;
    padding: 4px 10px;
    border-radius: var(--fl-radius-pill);
    background: #0008;
    color: #fff;
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .beatstrip {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .shots {
    position: relative;
    height: 40px;
    border-radius: var(--fl-radius-control);
    overflow: hidden;
    background: var(--fl-raised);
  }
  .shot {
    position: absolute;
    top: 0;
    bottom: 0;
    border-inline-end: 2px solid var(--fl-panel);
    overflow: hidden;
  }
  .shot img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .head {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #fff;
    box-shadow: 0 0 0 1px #0006;
  }
  .beats {
    position: relative;
    height: 10px;
  }
  .beats i {
    position: absolute;
    top: 2px;
    width: 1px;
    height: 4px;
    background: var(--fl-muted);
    opacity: 0.6;
  }
  .beats i.is-bar {
    top: 0;
    height: 8px;
    opacity: 1;
  }
  .facts {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .facts div {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .facts dt {
    font-size: var(--fl-font-micro);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fl-muted);
    font-weight: 600;
  }
  .facts dd {
    margin: 0;
    font-size: 14px;
  }
  @media (max-width: 640px) {
    .choices,
    .moods,
    .result {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
