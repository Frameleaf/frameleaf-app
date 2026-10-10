/**
 * Which kind of build this server is, fixed when the image is built (owner decision 2026-09-27).
 *
 * The source always says `release`. Only `.github/workflows/integration-image.yml` passes the Docker
 * build argument `FRAMELEAF_BUILD_CHANNEL=integration`, and `server/Dockerfile` then rewrites the
 * line below before the server is compiled, so the value is part of the compiled code. Nothing at
 * run time (environment, settings, image tag) can change it. Release builds (docker.yml, Deploy
 * production, every release path) never pass the argument.
 *
 * Keep the declaration on one line exactly as written: the Dockerfile matches it verbatim and fails
 * the build when it does not.
 */
export type FrameleafBuildChannel = 'release' | 'integration';

export const FRAMELEAF_BUILD_CHANNEL: FrameleafBuildChannel = 'release' as FrameleafBuildChannel;
