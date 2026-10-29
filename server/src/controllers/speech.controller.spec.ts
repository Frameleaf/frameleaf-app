import { Reflector } from '@nestjs/core';
import { SpeechController } from 'src/controllers/speech.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

it('requires account preference mutation permission for every speech mutation and refuses shared links', () => {
  const reflector = new Reflector();
  for (const method of ['updateSpeechSettings', 'retrySpeechIndexing', 'deleteSpeechIndex'] as const) {
    expect(getAuthenticatedOptions(reflector, SpeechController.prototype[method])).toMatchObject({
      permission: Permission.UserPreferenceUpdate,
      sharedLink: false,
      public: false,
    });
  }
  for (const method of ['getSpeechStatus', 'searchSpokenWords'] as const) {
    expect(getAuthenticatedOptions(reflector, SpeechController.prototype[method])).toMatchObject({
      permission: Permission.AssetRead,
      sharedLink: false,
    });
  }
});
