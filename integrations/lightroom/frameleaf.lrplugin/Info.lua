return {
  LrSdkVersion = 13.0,
  LrSdkMinimumVersion = 13.0,
  LrToolkitIdentifier = 'net.frameleaf.connect',
  LrPluginName = LOC '$$$/Frameleaf/PluginName=Frameleaf',
  LrPluginInfoUrl = 'https://frameleaf.app/docs/using/lightroom/',
  LrExportServiceProvider = {
    title = LOC '$$$/Frameleaf/ServiceTitle=Frameleaf',
    file = 'PublishServiceProvider.lua',
  },
  -- Receives lightroom://net.frameleaf.connect/oauth/callback after consent.
  URLHandler = 'URLHandler.lua',
  -- Stamped by scripts/package.sh from the repository version.
  VERSION = { major = 0, minor = 0, revision = 0, display = 'development' },
}
