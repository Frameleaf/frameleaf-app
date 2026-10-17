# Chromecast support

Frameleaf supports the Google's Cast protocol so that photos and videos can be cast to devices such as a Chromecast and a Nest Hub. This feature is considered experimental and has several important limitations listed below. This page covers casting from the web app; the Frameleaf Android app has Google Cast built in, and the iPhone app plays to an Apple TV with AirPlay.

## Enable Google Cast Support

Google Cast support is disabled by default. The web UI uses Google-provided scripts and must retrieve them from Google servers when the page loads. This is a privacy concern for some and is thus opt-in.

To enable it:

1. Open **Settings** from the sidebar and go to **Your preferences** → **Tools & sidebar**.
2. In the **Cast to a TV** row, turn on **Use**.

If the switch can't be turned on, your administrator has turned casting off for your account.

## Limitations

To use casting with Frameleaf, there are a few prerequisites:

1. Your instance must be accessed via an HTTPS connection in order for the casting menu to show.
2. Your instance must be publicly accessible via HTTPS and a DNS record for the server must be accessible via Google's DNS servers (`8.8.8.8` and `8.8.4.4`)
3. Videos must be in a format that is compatible with Google Cast. For more info, check out [Google's documentation](https://developers.google.com/cast/docs/media)
