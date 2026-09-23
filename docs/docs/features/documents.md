# Documents

**Documents** (in the sidebar under Explore) lists your photos that show text: receipts, signs, letters, screenshots, anything text recognition has read. A photo is listed because of the text read from it, and the search box finds photos by that text or by your own corrections to it.

## Text in this photo

Open a photo and its information panel ends with **Text in this photo**: the text as it reads now, **Show text regions** to draw where each line is over the photo, and **Select text** / **Copy text**.

The owner of a photo can also review its text:

- **Correct** a line that was misread. Your correction is stored beside the recognized text, never over it; the recognized text stays available as the record of what was read.
- **Dismiss** a line that is noise, and **Restore** it later.
- **Show where** points at the line's region on the photo; hovering or focusing a line does the same.
- **Read text again** queues text recognition for this photo on the processing destination chosen for text recognition in Settings. With no destination chosen, or with text recognition switched off, it says so instead of sending the photo anywhere.

People you share the photo with read it with your corrections applied and without the lines you dismissed. Only you see your review.

### When the photo changes

- **Read again**: your corrections follow the line that now covers the same place in the photo. If the new reading differs from the text you corrected, the line says so. A correction whose text is gone entirely is kept as your own text, and the old recognized text is not shown again.
- **Cropped**: text a crop removes is no longer read, listed or searchable, and your corrections of it are not shown while the crop hides it. Reading a cropped photo again keeps that text hidden, and search on a cropped photo matches only its visible text and values you typed yourself. Removing the crop brings them back.
- **Locked**: a locked photo's text is part of the photo. It is listed and readable only while your session is unlocked, and locking the session again clears it from the list and from an open information panel.

## Suggested details

An administrator can turn on **Suggest receipt and document fields** in the **OCR** section of the machine learning settings (off by default). The panel then suggests a **date**, a **total**, a **reference**, an **email address** and a **phone number** from the photo's text.

A suggestion is only what the text says. It shows where it was read and how confident the recognition was about that text, and it is never treated as a verified record: a well-read "12.50" can still be the wrong total, and day and month order in a date is not guessed. For each value you can:

- **Confirm** the suggestion, or pick one of the **Other readings**;
- **Correct** it to your own value;
- **Dismiss** it;
- **Reset** your decision so the suggestion shows again.

## Conflicts

Every change names the version of the text and of your decision it was made against. If the photo was read again, or you changed the same line on another device in the meantime, the change is refused, the panel reloads, and nothing is overwritten.

## API

| Endpoint                                | Purpose                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `GET /documents`                        | Your photos with visible text, newest first; `query` searches text.        |
| `GET /documents/{id}`                   | A photo's lines, their regions and, for the owner, suggested details.      |
| `PUT /documents/{id}/lines`             | Correct or dismiss one recognized line (`revision`, `recognizedText`).     |
| `DELETE /documents/{id}/lines/{editId}` | Restore a line (`revision`).                                               |
| `PUT /documents/{id}/fields/{field}`    | Confirm, correct or dismiss a suggested detail (`revision`).               |
| `DELETE /documents/{id}/fields/{field}` | Reset a decision about a detail (`revision`).                              |
| `POST /assets/jobs` with `refresh-ocr`  | Read a photo's text again through the routed text recognition destination. |

Reading needs `asset.read` and follows the photo's own sharing; changes need `asset.update` and the photo's owner. Shared links cannot use these endpoints.
