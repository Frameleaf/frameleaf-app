import { Reflector } from '@nestjs/core';
import { CaptureController } from 'src/controllers/capture.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

it('keeps the capture boundary private and grants only catalog or capture operations', () => {
  const reflector = new Reflector();
  for (const [handler, permission] of [
    [CaptureController.prototype.getCaptureCapabilities, Permission.CaptureCatalogRead],
    [CaptureController.prototype.getCaptureCatalog, Permission.CaptureCatalogRead],
    [CaptureController.prototype.commitCapture, Permission.CaptureCreate],
    [CaptureController.prototype.createCaptureAlbum, Permission.CaptureCreate],
    [CaptureController.prototype.createCaptureUpload, Permission.CaptureCreate],
    [CaptureController.prototype.getCaptureUpload, Permission.CaptureCreate],
    [CaptureController.prototype.getCaptureUploadOffset, Permission.CaptureCreate],
    [CaptureController.prototype.appendCaptureUpload, Permission.CaptureCreate],
    [CaptureController.prototype.cancelCaptureUpload, Permission.CaptureCreate],
  ] as const) {
    expect(getAuthenticatedOptions(reflector, handler)).toEqual(
      expect.objectContaining({ permission, sharedLink: false }),
    );
  }
});
