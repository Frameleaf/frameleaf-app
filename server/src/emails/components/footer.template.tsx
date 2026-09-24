import { Text } from '@react-email/components';
import * as React from 'react';

// FL-135: Frameleaf native apps are not published in the app stores yet, so the footer shows no
// store badges and links to no third-party site; it only carries the licence notice.
export const ImmichFooter = () => (
  <Text className="text-center text-sm text-immich-footer">
    Frameleaf is free software available under the GNU AGPL v3 license.
  </Text>
);
