---
slug: /features/privacy
---

# Privacy and connections

Frameleaf stores your media on your own server. You choose who can see it and which optional services may process it. Local machine learning can prepare search, faces, text and descriptions without sending your photos to a remote inference service.

## Network requests

Application telemetry, usage collectors and metrics exporters are disabled. Local logs, health checks and job progress remain available. This does not mean the server makes no network requests:

| Feature                                    | Connection                                                      |
| ------------------------------------------ | --------------------------------------------------------------- |
| Installation and updates                   | Frameleaf image and release hosts                               |
| Search, face and OCR models                | Configured model source; by default the Frameleaf model mirror  |
| Description and sensitive-content models   | Hugging Face, a configured mirror or a prefilled local cache    |
| Maps                                       | Configured map tiles; the default uses Frameleaf's tile host    |
| Remote processing                          | The endpoint selected for that task, after its required consent |
| Email, OAuth, casting and account services | The services you explicitly configure or enable                 |

Download hosts receive ordinary request information such as the network address and requested file. A remote processing endpoint receives the image or prompt needed for its task. Review [Workers and endpoints](/administration/workers-and-endpoints) before enabling one. Model-source and offline-cache options are documented under [Machine-learning environment variables](/install/environment-variables#machine-learning).

Version checking is off by default. When enabled, it uses Frameleaf's release feed and GitHub releases. Administrator-added plugins and host software have their own behavior; application settings do not act as a network firewall for them.

## Private items

Use [Locked](/features/locked) to hide private photos behind your PIN. Mark items yourself or choose Locked people, pets and tags. Sensitive-content detection is optional and can be wrong: review its results before enabling automatic hiding.

Locked rules affect your browsing and do not withdraw sharing you deliberately created. To stop sharing an item, remove the share or lock the item itself. A visible tag is metadata, not an access-control rule. The [Locked guide](/features/locked) explains these distinctions and the effect on albums, memories and Studio.

Use HTTPS, particularly on shared browsers. Sign out when finished and keep separate accounts for separate people.

## Original files and storage

Photo edits retain the original. [Physical deduplication](/features/physical-deduplication) can share identical stored bytes while keeping account records and permissions separate. Neither feature replaces backups. Keep independent [database and media recovery copies](/administration/backup-and-restore).
