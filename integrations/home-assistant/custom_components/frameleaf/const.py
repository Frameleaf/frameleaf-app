"""Constants for the Frameleaf integration."""

from datetime import timedelta
from typing import Final

DOMAIN: Final = "frameleaf"

CONF_AUTH_METHOD: Final = "auth_method"
CONF_CLIENT_ID: Final = "client_id"
CONF_EVENTS: Final = "events"
CONF_WEBHOOK_ID: Final = "webhook_id"
CONF_WEBHOOK_SECRET: Final = "webhook_secret"
CONF_WORKFLOW_IDS: Final = "workflow_ids"

AUTH_OAUTH: Final = "oauth"
AUTH_API_KEY: Final = "api_key"

# FL-803: Home Assistant asks only to see the library. Nothing here can change, share or delete.
OAUTH_SCOPES: Final = "library:read"
CLIENT_NAME: Final = "Home Assistant"

SCAN_INTERVAL: Final = timedelta(minutes=5)
# a new picture for dashboards and frames every so often, not on every refresh
IMAGE_ROTATE: Final = timedelta(minutes=10)

# FL-819: what Frameleaf sends is fired on the Home Assistant bus under this name
EVENT_FRAMELEAF: Final = "frameleaf_event"
# a signed message older (or newer) than this is refused, so a captured one cannot be replayed later
SIGNATURE_TOLERANCE_SECONDS: Final = 300
WEBHOOK_METHOD: Final = "immich-plugin-core#webhook"
