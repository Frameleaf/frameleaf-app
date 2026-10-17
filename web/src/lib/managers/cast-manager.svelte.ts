import { createSession, type SessionCreateResponseDto } from '@frameleaf/sdk';
import { DateTime, Duration } from 'luxon';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { GCastDestination } from '$lib/utils/cast/gcast-destination.svelte';

// follows chrome.cast.media.PlayerState
export enum CastState {
  IDLE = 'IDLE',
  PLAYING = 'PLAYING',
  PAUSED = 'PAUSED',
  BUFFERING = 'BUFFERING',
}

export enum CastDestinationType {
  GCAST = 'GCAST',
}

export interface ICastDestination {
  initialize(): Promise<boolean>; // returns if the cast destination can be used
  type: CastDestinationType; // type of cast destination

  isAvailable: boolean; // can we use the cast destination
  isConnected: boolean; // is the cast destination actively sharing

  currentTime: number | null; // current seek time the player is at
  duration: number | null; // duration of media

  receiverName: string | null; // name of the cast destination
  castState: CastState; // current state of the cast destination

  loadMedia(mediaUrl: string, sessionKey: string, reload: boolean): Promise<void>; // load media to the cast destination

  // remote player controls
  play(): void;
  pause(): void;
  seekTo(time: number): void;
  disconnect(): void;
}

class CastManager {
  private castDestinations = $state<ICastDestination[]>([]);
  private current = $derived<ICastDestination | null>(this.monitorConnectedDestination());

  availableDestinations = $state<ICastDestination[]>([]);
  initialized = $state(false);
  private initialization: Promise<void> | undefined;

  isCasting = $derived<boolean>(this.current?.isConnected ?? false);
  receiverName = $derived<string | null>(this.current?.receiverName ?? null);
  castState = $derived<CastState | null>(this.current?.castState ?? null);
  currentTime = $derived<number | null>(this.current?.currentTime ?? null);
  duration = $derived<number | null>(this.current?.duration ?? null);

  private sessionKey: SessionCreateResponseDto | null = null;
  private sessionKeyIsCurrent: (() => boolean) | undefined;
  private sessionKeyRequest:
    | {
        isCurrent: () => boolean;
        promise: Promise<SessionCreateResponseDto>;
      }
    | undefined;

  constructor() {
    // load each cast destination
    this.castDestinations = [
      new GCastDestination(),
      // Add other cast destinations here (ie FCast)
    ];

    eventManager.on({
      AppInit: () => void this.initialize().catch((error) => console.error('Failed to initialize casting', error)),
    });
  }

  private initialize(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    this.initialization ??= (async () => {
      const available: ICastDestination[] = [];
      for (const destination of this.castDestinations) {
        if (await destination.initialize()) {
          available.push(destination);
        }
      }
      this.availableDestinations.push(...available);
      this.initialized = true;
    })().finally(() => {
      this.initialization = undefined;
    });
    return this.initialization;
  }

  // monitor all cast destinations for changes
  // we want to make sure only one session is active at a time
  private monitorConnectedDestination(): ICastDestination | null {
    // check if we have a connected destination
    const connectedDest = this.castDestinations.find((dest) => dest.isConnected);
    return connectedDest || null;
  }

  private isTokenValid() {
    // check if we already have a session token
    // we should always have a expiration date
    if (!this.sessionKeyIsCurrent?.() || !this.sessionKey || !this.sessionKey.expiresAt) {
      return false;
    }

    const tokenExpiration = DateTime.fromISO(this.sessionKey.expiresAt);

    // we want to make sure we have at least 10 seconds remaining in the session
    // this is to account for network latency and other delays when sending the request
    const bufferedExpiration = tokenExpiration.minus({ seconds: 10 });

    return bufferedExpiration > DateTime.now();
  }

  private async refreshSessionToken() {
    if (this.isTokenValid()) {
      return this.sessionKey;
    }
    if (this.sessionKeyRequest?.isCurrent()) {
      return this.sessionKeyRequest.promise;
    }
    const request = {
      isCurrent: authManager.captureSession(),
      promise: createSession({
        sessionCreateDto: {
          duration: Duration.fromObject({ minutes: 15 }).as('seconds'),
          deviceOS: 'Google Cast',
          deviceType: 'Cast',
        },
      }),
    };
    this.sessionKeyRequest = request;
    try {
      const key = await request.promise;
      if (request.isCurrent()) {
        this.sessionKey = key;
        this.sessionKeyIsCurrent = request.isCurrent;
      }
      return key;
    } finally {
      if (this.sessionKeyRequest === request) {
        this.sessionKeyRequest = undefined;
      }
    }
  }

  async loadMedia(mediaUrl: string, reload: boolean = false) {
    const destination = this.current;
    if (!destination) {
      throw new Error('No active cast destination');
    }

    const isCurrentSession = authManager.captureSession();
    const key = await this.refreshSessionToken();
    if (!isCurrentSession() || this.current !== destination || !destination.isConnected) {
      return;
    }
    if (!key) {
      throw new Error('No session key available');
    }

    await destination.loadMedia(mediaUrl, key.token, reload);
  }

  play() {
    this.current?.play();
  }

  pause() {
    this.current?.pause();
  }

  seekTo(time: number) {
    this.current?.seekTo(time);
  }

  disconnect() {
    this.current?.disconnect();
  }
}

// Persist castManager across Svelte HMRs
let castManager: CastManager;

if (import.meta.hot && import.meta.hot.data) {
  if (!import.meta.hot.data.castManager) {
    import.meta.hot.data.castManager = new CastManager();
  }
  castManager = import.meta.hot.data.castManager;
} else {
  castManager = new CastManager();
}

export { castManager };
