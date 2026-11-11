import { ForbiddenException, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { signInIsRecent } from 'src/utils/confirmed-recently.js';
import { privateLogStore } from 'src/utils/private-log-runtime.js';

@Injectable()
export class PrivateLogsService {
  constructor(
    private config: ConfigRepository,
    private sessions: SessionRepository,
    private accounts: FrameleafAccountRepository,
    private users: UserRepository,
    private storage: StorageRepository,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- callers await it; the rule is now synchronous
  async authorize(auth: AuthDto, via: FrameleafVia | null) {
    if (!auth.user.isAdmin || !auth.session || auth.sharedLink || auth.apiKey) {
      throw new ForbiddenException('Server logs require an administrator session');
    }
    if ((via === 'relay' || via === 'wan') && !signInIsRecent(auth.session.signIn)) {
      // confirmed recently: a Frameleaf sign-in or a local passkey from the last 10 minutes
      throw new ForbiddenException('Sign in again to read server logs remotely');
    }
  }

  async authorizeLive(auth: AuthDto, via: FrameleafVia | null) {
    await this.authorize(auth, via);
    const [session, user] = await Promise.all([this.sessions.get(auth.session!.id), this.users.get(auth.user.id, {})]);
    if (!user?.isAdmin || !session || (session.expiresAt && session.expiresAt <= new Date())) {
      throw new ForbiddenException('The administrator session ended');
    }
  }

  store() {
    const env = this.config.getEnv();
    return privateLogStore(env.logRetentionDays, env.storage.mediaLocation);
  }

  download(hours: number) {
    const store = this.store();
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const stream = Readable.from(
      (async function* () {
        for await (const entries of store.read({ since })) {
          for (const entry of entries) yield JSON.stringify(entry) + '\n';
        }
      })(),
    );
    const archive = this.storage.createZipStream();
    archive.addFile(stream, 'frameleaf-server-logs.jsonl');
    void archive.finalize().catch((error: Error) => archive.stream.destroy(error));
    return archive.stream;
  }
}
