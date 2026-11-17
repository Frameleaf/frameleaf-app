# `frameleaf-repository` version 1

A repository is a set of immutable objects in one place: a prefix in an S3 bucket, or a folder. One
machine writes to it. Everything except `config` is encrypted with keys that never leave the machine.
The storage provider can see how many objects there are, how big they are and when they were written,
and nothing else: no file names, no folder shapes, no chunk boundaries.

All integers are big-endian. Hex is lower case.

## Keys

| Key            | From                           | Used for                                |
| -------------- | ------------------------------ | --------------------------------------- |
| root key       | the caller (32 bytes)          | wraps the repository key in `config`    |
| repository key | 32 random bytes made by `init` | everything below                        |
| `id`           | HKDF                           | names blobs                             |
| `blob`         | HKDF                           | base key for blob encryption            |
| `cut`          | HKDF                           | the chunker's table                     |
| `meta`         | HKDF                           | pack trailers, index objects, snapshots |

HKDF is HKDF-SHA256 with the repository key as input, the repository id (its UUID text) as salt, and
`frameleaf-repository/1 <name>` as info, 32 bytes out. Changing the root key rewrites only `config`.

**Sealing** is AES-256-GCM: `nonce(12) | ciphertext | tag(16)`, random nonce, with associated data
named in each section.

## Objects

| Name                     | Content                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`                 | JSON, not encrypted: `format`, `version`, `repoId`, `chunker` `{min, avg, max}`, `keyVersion` (the caller's label for the root key), `wrappedKey` (base64 of the repository key sealed with the root key; associated data `frameleaf-repository/1 <repoId>`) |
| `p/<32 hex>`             | a pack                                                                                                                                                                                                                                                       |
| `i/<32 hex>`             | an index object                                                                                                                                                                                                                                              |
| `s/<12 digits>-<16 hex>` | a snapshot; the digits are its sequence number. A reader accepts 16 to 64 hex characters                                                                                                                                                                     |

Pack and index names are random. They carry no meaning. Every object is written once: storing under a
name that is taken is refused.

## Chunks

A file is cut by FastCDC with normalised chunking over a 32-bit gear hash,
`hash = (hash << 1) + gear[byte]`, started at zero `min` bytes into each chunk.

- `gear` is 256 little-endian 32-bit values: HKDF-SHA256 of the `cut` key, empty salt, info
  `frameleaf-repository/1 gear`, 1024 bytes. Boundaries therefore depend on the key.
- With `bits = log2(avg)`: before `avg` bytes a cut needs the top `bits + 2` bits of the hash to be
  zero; from `avg` on, the top `bits - 2` bits. A chunk never exceeds `max`. The end of the file ends
  the last chunk.
- Defaults: `min` 512 KiB, `avg` 2 MiB, `max` 8 MiB. The values in `config` are the ones in force.

## Blobs

A blob is a chunk of file content, a tree, or a chunk list.

- **Id**: HMAC-SHA256 with the `id` key over the plaintext. 32 bytes.
- **Stored form**: `flag(1) | sealed`. Flag 1 means the plaintext was compressed with zstd first;
  flag 0 means it was not (compression is kept only when it saves at least one sixteenth).
- **Blob key**: HKDF-SHA256 of the `blob` key, salt the blob id, info `frameleaf-repository/1 blob`.
  Associated data: `id | flag`.

## Packs

```
blob | blob | ... | sealed trailer | trailer length (4) | "FLRP0001"
```

The trailer, before sealing, is one 40-byte record per blob in order: `id(32) | offset(4) | length(4)`.
It is sealed with the `meta` key; associated data is the pack's object name. A reader fetches the
last 12 bytes, then the trailer, then any blob by byte range. Packs aim for 64 MiB. Trees and chunk
lists go into packs of their own so that browsing fetches little.

**The trailer is the authority on what a pack holds.** The index is a faster copy of it.

## Index objects

Sealed with the `meta` key (associated data: the object name) over zstd of, for each pack:
`pack id(16) | count(4) | count x 40-byte records` as in the trailer.

## Trees

JSON `{ "v": 1, "entries": [...] }`, entries sorted by `name` in code-unit order. An entry has `name`,
`type` (`file`, `dir`, `symlink`), `mode`, `uid`, `gid`, `mtime` (milliseconds), `size`, and:

- `dir`: `tree`, the id of its tree blob;
- `symlink`: `target`;
- `file`: `chunks`, the chunk ids in order, or for more than 1024 chunks `lists`, ids of blobs that
  each hold up to 32768 chunk ids as 32 raw bytes apiece;
- optionally `key`, the source's change marker (see below).

Equal folders have equal ids, so an unchanged folder costs nothing in the next snapshot, and browsing
one folder reads one small blob.

## Snapshots

Sealed with the `meta` key (associated data: the object name):
`{ v, repoId, seq, time, tree, parent, stats }`. `seq` equals the digits in the name. Snapshots are
ordered by `seq`, then by name; `time` is information only, so a wrong clock cannot reorder history.

Where a signed history of snapshots is kept outside the repository (Frameleaf Cloud keeps one), the
writer takes each number from that history. A run that stored its snapshot but stopped before the
history recorded it leaves a snapshot whose number the next run uses again. Both can be restored;
only the recorded one is part of the signed history.

## Rules that keep data safe

1. **Write order**: packs, then the index object, then the snapshot. A snapshot is the last thing
   written, so it never points at something that is not stored.
2. **Trust storage, not memory**: every run lists `p/` and `i/`. A blob counts as stored only if its
   pack is in that listing. Index entries for a missing pack are ignored.
3. **Adopt orphans**: a listed pack that no index object mentions is read from its trailer. A run
   that stopped before its index was written loses nothing and re-sends nothing.
4. **Reuse carefully**: a file is taken from the previous snapshot without reading it only when its
   change marker matches (`key` when both have one, otherwise size and `mtime`) and every one of its
   chunks is stored. Otherwise it is read again.
5. **One writer**: backup and prune never run together on one repository. The caller holds a lock
   (locally, and a lease in Frameleaf Cloud).
6. **Restore never deletes**: a file in the way is renamed first.

## Prune

Prune removes snapshots the retention policy no longer keeps, and the data only they needed. It
changes nothing in the format; it only deletes objects and writes new packs and one new index.

Retention keeps: the newest few snapshots whatever their age (never fewer than one), every snapshot
younger than a number of days, and beyond that the newest snapshot of each calendar month (UTC) for a
number of months. The defaults are 3, 90 days and 12 months.

A blob is **needed** if a kept snapshot reaches it through its trees. Prune stops before changing
anything if a needed blob is not stored: a damaged repository is never thinned.

Each pack older than the minimum age (90 days by default, because storage is billed that long
anyway) is deleted if it holds nothing needed, or rewritten if less than half of its bytes are
needed: the needed blobs are opened to check them and copied, as stored, into new packs.

The order makes every stopping point safe:

1. snapshots that are no longer kept are deleted, so nothing points at what goes next;
2. new packs are written;
3. one new index object is written, then the old index objects are deleted;
4. unneeded packs are deleted last.

After a stop at any step, every remaining snapshot is whole and a second prune finishes the job.
A blob that ends up in two packs is harmless; the next prune removes the spare.

## Verify

Verify changes nothing. It walks every snapshot and reports snapshots that cannot be opened and
needed blobs that are not stored. For the packs it is asked to read, it downloads each one, opens
every blob and checks that the blob's id matches its content.

## Known limits of version 1

- The index is held in memory (about 200 MB per million blobs).
- A pack is built in memory before it is written.
- Extended attributes, ACLs and hard links are not recorded.
- A change in a file is noticed while reading only if its size changes.
- Restore works by path. It must run where nothing else can change the destination or any folder on the
  way to it: a process that can swap one of those for a link while a restore runs could send files
  elsewhere. A destination that is itself a link to a folder is followed, as the caller named it.
