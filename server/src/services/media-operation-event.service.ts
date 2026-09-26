import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { MediaOperationChange, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';

/**
 * Tells an owner's open pages that one of their jobs changed (FL-43, `on_media_operation_update`).
 *
 * The event carries the job id and nothing else, and goes only to the owner's own sockets. Activity
 * answers it by asking the owner-scoped list again, so what it shows is always read through the same
 * access and Locked-folder checks as any other request; the nudge itself never reveals a label, an
 * asset or a status. Every process that writes jobs — the API and the workers — sends its own.
 */
@Injectable()
export class MediaOperationEventService {
  private unsubscribe?: () => void;

  constructor(
    private operations: MediaOperationRepository,
    private websocket: WebsocketRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap' })
  onBootstrap() {
    this.unsubscribe ??= this.operations.onChange((changes) => this.notify(changes));
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  notify(changes: MediaOperationChange[]) {
    const seen = new Set<string>();
    for (const { id, ownerId } of changes) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      this.websocket.clientSend('on_media_operation_update', ownerId, id);
    }
  }
}
