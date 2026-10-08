# Studio

Studio is Frameleaf's project editor for working with clips and other media from your library. Open **Studio** from the library navigation or the available action on selected media. Its availability and rendering options depend on the installed editor build, browser capabilities and configured workers.

## Create and reopen a project

Choose media you can access, open it in Studio and save the project. Saved projects appear in the Studio project library, where you can reopen your work. Keep the page open until the save completes and heed any unsaved-changes warning when leaving.

Project state is separate from the original library files. Removing an item from the timeline does not delete its original. Imported project files and recordings can become project dependencies, so include them in your backup plan.

## Edit and review

Arrange clips in the timeline and use the tools available for your project. Review comments can refer to the current playhead. Saving, history and access checks apply to the project; if access changes or another editing session conflicts, resolve the displayed state before continuing.

A browser preview and a server-rendered preview can differ in capability. Follow the displayed preview labels and any unavailable-worker message. A preview is not proof that an export has completed.

## Export

Open the export dialog and choose an available output and destination. Unsupported combinations are refused rather than silently producing a different result. Track the job in **Activity**, then open or download the completed export. Keep the project and originals if you want to make another edit later.

A project bundle preserves the project for transfer; include media when you need a self-contained copy. It is distinct from a finished video and from a complete server backup. See [Preservation packages](/features/preservation) and [Backup and restore](/administration/backup-and-restore) for library recovery.

## Private media

Your PIN session controls access to Locked sources. Locking the session hides those clips and posters while retaining their project references; unlock to work with them again. Exports and bundles containing Locked media follow the source access checks. See [Locked](/features/locked#studio).
