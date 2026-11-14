import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { type ConnectEventQuery, ConnectEventRepository } from 'src/repositories/connect-event.repository.js';

@Injectable()
export class ConnectEventService {
  constructor(private events: ConnectEventRepository) {}
  read(auth: AuthDto, query: ConnectEventQuery) {
    return this.events.read(auth, query);
  }
  latest(auth: AuthDto, query: ConnectEventQuery) {
    return this.events.read(auth, query, 'latest');
  }
  sample(auth: AuthDto, query: ConnectEventQuery) {
    return this.events.sample(auth, query);
  }
  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  onNightlyDatabaseCleanup() {
    return this.events.cleanup();
  }
}
