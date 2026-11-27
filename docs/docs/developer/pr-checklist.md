# PR Checklist

A minimal devcontainer is supplied with this repository. All commands can be executed directly inside this container to avoid tedious installation of the environment.
:::warning
The provided devcontainer isn't complete at the moment. At least the dockerized `mise` tasks (`mise dev`, ...) won't work. Feel free to contribute!
:::
When contributing code through a pull request, please check the following:

## Web Checks

- [ ] `mise //web:lint` (linting via ESLint)
- [ ] `mise //web:format` (formatting via Prettier)
- [ ] `mise //web:check-svelte` (type checking via SvelteKit)
- [ ] `mise //web:check-typescript` (type checking via `tsc`)
- [ ] `mise //web:test` (unit tests)

:::tip AIO
Run all web checks with `mise //web:checklist`
:::

:::tip Auto Fix
Use `mise //web:lint-fix` and `mise //web:format-fix` to automatically correct some issues.
:::

## Web: empty, loading, saved and failed states

Every page shows these the same way. Use the shared pieces in `web/src/lib/components/frameleaf/`; do not write a new empty block, "Loading…" line or "Saved" message for one page.

| What happened                                       | What to use                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Nothing here yet, whole page                        | `EmptyState`: icon, what will be here and how it gets here, at most one main action.                                        |
| Nothing here yet, one section of a page             | `EmptyRow`: one line and at most one action. The page keeps its layout.                                                     |
| Loading a list or a grid                            | `ListSkeleton`, `GridSkeleton` or `Skeleton`. No "Loading…" text and no spinner.                                            |
| A button is working                                 | The button is disabled while it works and shows it is busy (`loading` on the `@frameleaf/ui` `Button`). Nothing else moves. |
| A setting or a field was saved                      | `StatusLine` beside it: Saving…, then Saved, or why it was not saved. No toast.                                             |
| An action finished somewhere else, or can be undone | A toast (`toastManager`; `toastUndo` from `$lib/frameleaf/toast` when it can be undone).                                    |
| A list or page could not be read                    | `InlineError` in place of the content, with `onRetry`. Never a toast, never a blank page.                                   |
| An action failed                                    | A toast that says what failed and why: `handleError(error, $t('…'))`, which adds the reason. Never silent.                  |

- [ ] New or changed pages use these pieces for every state they can be in.
- [ ] Spacing uses the `--fl-space-*` tokens (1–6, 8, 10, 12, 16) and colours use the `--fl-*` role tokens, never a hex value.

## Documentation

- [ ] `mise //docs:format` (formatting via Prettier)
- [ ] Update the `_redirects` file if you have renamed a page or removed it from the documentation.

:::tip Auto Fix
Use `mise //docs:format-fix` to automatically fix formatting.
:::

## Server Checks

- [ ] `mise //server:lint` (linting via ESLint)
- [ ] `mise //server:format` (formatting via Prettier)
- [ ] `mise //server:check` (type checking via `tsc`)
- [ ] `mise //server:test` (unit tests)

:::tip AIO
Run all server checks with `mise //server:checklist`
:::

:::tip Auto Fix
Use `mise //server:lint-fix` and `mise //server:format-fix` to automatically correct some issues.
:::

## Machine Learning Checklist

- [ ] `mise //machine-learning:lint` (linting via ruff)
- [ ] `mise //machine-learning:format` (formatting via ruff)
- [ ] `mise //machine-learning:check` (type checking via mypy)
- [ ] `mise //machine-learning:test` (unit tests via pytest)

:::tip AIO
Run all machine learning checks with `mise //machine-learning:checklist`
:::

## OpenAPI

The OpenAPI client libraries need to be regenerated whenever there are changes to the `immich-openapi-specs.json` file. Note that you should not modify this file directly as it is auto-generated. See [OpenAPI](/api.md) for more details.

## Database Migrations

A database migration needs to be generated whenever there are changes to the schema definitions in `server/src/schema`. See [Database Migration](/developer/database-migrations.md) for more details.
