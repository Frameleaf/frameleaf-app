/**
 * FL-422: the server-wide editing defaults that Settings › Editing & playback sets, as every signed-in
 * account reads them (`GET /config`): where the video editor starts a new trim ("How trims are cut")
 * and the style a video restoration starts on ("Restoration style").
 *
 * Read once per session. Until the answer comes, and when it can't be read, they are what the server
 * does without the settings: precise trims and faithful restoration. An administrator's save in this
 * tab updates them straight away; another account sees the change the next time it signs in.
 */
import {
  AssetRestorationMode,
  getUserConfig,
  RestorationStyle,
  VideoTrimMode,
  type AdminConfigEditingDto,
  type UserConfigEditingDto,
} from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

/** What an older server, or a partial answer, may leave out. */
type Editing = Partial<Pick<UserConfigEditingDto, 'trimMode'>> & { restoration?: { style?: RestorationStyle } };

export class EditingDefaults {
  #trimMode = $state<VideoTrimMode>(VideoTrimMode.Precise);
  #style = $state<RestorationStyle>(RestorationStyle.Faithful);
  #loading: Promise<void> | undefined;

  constructor() {
    eventManager.on({
      SystemConfigUpdate: (config) => this.#apply(config.editing),
      AuthLogout: () => {
        this.#loading = undefined;
        this.#apply({ trimMode: VideoTrimMode.Precise, restoration: { style: RestorationStyle.Faithful } });
      },
    });
  }

  /** Where the video editor starts a new trim. */
  get trimMode(): 'precise' | 'fast' {
    return this.#trimMode === VideoTrimMode.Fast ? 'fast' : 'precise';
  }

  /** The mode a video restoration starts on. */
  get restorationMode(): AssetRestorationMode {
    return this.#style === RestorationStyle.Creative ? AssetRestorationMode.Creative : AssetRestorationMode.Faithful;
  }

  /** Reads the defaults once; later calls share the first answer. Never rejects. */
  load(): Promise<void> {
    // The answer is typed as complete, but an older server leaves `editing` out.
    this.#loading ??= Promise.resolve()
      .then(() => getUserConfig())
      .then((config) => this.#apply((config as { editing?: Editing } | undefined)?.editing))
      .catch(() => {
        // No answer: the editor keeps what the server does without the settings.
      });
    return this.#loading;
  }

  #apply(editing: Editing | AdminConfigEditingDto | undefined) {
    if (editing?.trimMode && Object.values(VideoTrimMode).includes(editing.trimMode)) {
      this.#trimMode = editing.trimMode;
    }
    const style = editing?.restoration?.style;
    if (style && Object.values(RestorationStyle).includes(style)) {
      this.#style = style;
    }
  }
}

export const editingDefaults = new EditingDefaults();
