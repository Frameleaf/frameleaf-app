import 'reflect-metadata';
import { AssetUploadDirectService } from '../../dist/services/asset-upload-direct.service.js';
import { RTCPeerConnection } from 'werift';

// Fixture-only injection; the production factory always uses the approved Frameleaf STUN hosts.
AssetUploadDirectService.prototype.createPeer = function () {
  return new RTCPeerConnection({
    iceServers: [{ urls: 'stun:127.0.0.1:3479' }],
    maxMessageSize: 65_536,
  });
};
