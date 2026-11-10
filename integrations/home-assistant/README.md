# Frameleaf for Home Assistant

Sensors for your Frameleaf library, a picture for dashboards and photo frames, and Frameleaf events on the Home Assistant bus.

## Install

In HACS, add this repository as a custom repository (type: Integration), install **Frameleaf**, restart Home Assistant, then add the integration under **Settings › Devices & services**. A Frameleaf server on your network is found by itself.

## Sign in

- **Sign in through Frameleaf** (recommended). Home Assistant asks to see your library and nothing more. You allow it on Frameleaf's Allow page and can remove it at any time under **Connected apps**; Home Assistant then asks you to sign in again.
- **API key**. Make a key under **Settings › API keys**. An administrator's key also shows storage, Cloud Backup and things that need attention, adds a button that looks for new files in the library folders, and can send Frameleaf events.

## What you get

| Entity             | Shows                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| Photos, Videos     | How many are in your library                                                        |
| Last phone backup  | When a phone last finished backing up (API key)                                     |
| Storage used       | Space used on the server (administrator key)                                        |
| Cloud Backup       | Backed up, backing up, failed or not set up (administrator key)                     |
| Things to look at  | Items Frameleaf says need attention (administrator key)                             |
| Picture            | Today's memory, or one of your favourites; never a Locked, hidden or archived photo |
| Look for new files | Starts a library scan (administrator key)                                           |

## Frameleaf events

With an administrator key and **Send Frameleaf events** on, the integration adds a workflow in Frameleaf for each event (Studio export finished, Cloud Backup finished or failed, Clients gallery approved, Frameleaf Cloud job finished). Each one sends a signed message to Home Assistant, which fires it as `frameleaf_event`:

```yaml
trigger:
  - platform: event
    event_type: frameleaf_event
    event_data:
      event: cloud.backup.failed
```

Messages that are not signed (over the timestamp, delivery id and body) with the integration's secret, are more than five minutes old, or were already received are ignored. If Home Assistant is only reachable at a home address (such as `http://homeassistant.local:8123`), turn on **Allow automations to call devices on my network** in Frameleaf under **Settings › Server name & welcome**.

## Development

```sh
uv run pytest
uv run ruff check . && uv run ruff format --check .
```
