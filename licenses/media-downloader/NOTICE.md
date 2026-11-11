# Media extraction runtime

Frameleaf runs the media extractor as a separate Python process. The production image installs the
unmodified Python wheels locked in `server/resources/media-downloader/requirements.lock`.
Their distributed licence texts are kept in
`/opt/frameleaf-media-downloader/venv/lib/python3.13/site-packages/*.dist-info`.

| Component | Upstream licence | Pinned corresponding source | Source SHA-256 |
| --- | --- | --- | --- |
| yt-dlp 2026.10.26 | The Unlicense | [Source distribution](https://files.pythonhosted.org/packages/83/31/4be3987022a6244550ab6a3afe45ad10ac10b5e5ab8874bd8eecc7f8b937/yt_dlp-2026.10.26.tar.gz) | `abe5c6b94c3b2f0560500add1c42e0a97641752743a5b65588ac2007a6e23eb6` |
| gallery-dl 1.32.19, Mike Fährmann and contributors | GPL-2.0-only | [Source distribution](https://files.pythonhosted.org/packages/1a/71/f233d60f40e37381f33590907f0884da453e46963112fb22f352dc1def26/gallery_dl-1.32.19.tar.gz) | `63323bc1bc37b8ba25c19d2ef7a86158d1f79cccaee8d69dda907986f3f3e824` |
| yt-dlp-ejs 0.8.0 | The Unlicense, MIT, and ISC | [Source distribution](https://files.pythonhosted.org/packages/d3/e6/cceb9530e8f4e5940f6f7822d90e9d94f1b85343329a16baaf47bbbb3de1/yt_dlp_ejs-0.8.0.tar.gz) | `d5fa1639f63b5c4af8d932495f60689d5370f1a095782c944f7f62a303eb104e` |
| curl-cffi 0.17.0 | MIT | [Source distribution](https://files.pythonhosted.org/packages/96/4c/69074f9797d83a5401b3c6bc58c5de5aad6d1a085d0497b87a093a152e87/curl_cffi-0.17.0.tar.gz) | `31ee8500d06d6502ce1ec0b7ded1c5aa8e8f3401bbe37ccd78d6153d859d8f3c` |

The runtime also uses the server image's existing Node.js and Jellyfin FFmpeg packages.
