import { Reflector } from '@nestjs/core';
import { ConnectMediaController } from 'src/controllers/connect-media.controller.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

describe('Connect media route authorization declarations', () => {
  it('allows an opaque ticket to reach its live-grant validator without requiring a session', () => {
    expect(getAuthenticatedOptions(new Reflector(), ConnectMediaController.prototype.ticket)).toMatchObject({
      public: true,
    });
  });
  it.each([
    'start',
    'head',
    'state',
    'append',
    'commit',
    'cancel',
    'rendition',
    'createTicket',
    'createAlbum',
  ] as const)('isolates %s behind Connect token authentication', (method) => {
    expect(getAuthenticatedOptions(new Reflector(), ConnectMediaController.prototype[method])).toMatchObject({
      connect: true,
      public: false,
    });
  });
});
