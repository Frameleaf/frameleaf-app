local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'

local Connect = require 'Connect'
local Util = require 'Util'

local bind = LrView.bind

local provider = {}

provider.supportsIncrementalPublish = 'only'
provider.allowFileFormats = { 'JPEG' }
provider.allowColorSpaces = { 'sRGB' }
provider.canExportVideo = false
-- Metadata is set below so title, caption and copyright travel and people/location do not.
provider.hideSections = { 'exportLocation', 'fileNaming', 'video', 'metadata' }

provider.exportPresetFields = {
  { key = 'libraryUrl', default = '' },
  { key = 'clientId', default = '' },
  { key = 'addKeywordTags', default = false },
  { key = 'includeLocation', default = false },
}

function provider.updateExportSettings(settings)
  settings.LR_format = 'JPEG'
  settings.LR_export_colorSpace = 'sRGB'
  settings.LR_embeddedMetadataOption = 'all'
  settings.LR_removeLocationMetadata = not settings.includeLocation
  settings.LR_removeFaceMetadata = true
end

---------------------------------------------------------------------------
-- Settings dialog
---------------------------------------------------------------------------

local function refreshStatus(props)
  local library = Util.normalizeLibraryUrl(props.libraryUrl)
  props.connected = library ~= nil and Connect.isConnected(library)
  props.status = props.connected and LOC('$$$/Frameleaf/Status/Connected=Connected to ^1', library)
    or LOC '$$$/Frameleaf/Status/NotConnected=Not connected'
end

local function connect(props)
  LrTasks.startAsyncTask(function()
    local library = Util.normalizeLibraryUrl(props.libraryUrl)
    if not library then
      LrDialogs.message(LOC '$$$/Frameleaf/Title=Frameleaf', LOC '$$$/Frameleaf/Error/NoAddress=Enter your Library address first.', 'warning')
      return
    end
    props.libraryUrl = library
    props.busy = true
    props.status = LOC '$$$/Frameleaf/Status/Waiting=Finish connecting in your browser…'
    local ok, err = LrTasks.pcall(Connect.beginSignIn, library, props.clientId, props.addKeywordTags)
    if ok then Connect.waitForSignIn(library) end
    props.busy = false
    refreshStatus(props)
    if not ok then LrDialogs.message(LOC '$$$/Frameleaf/Title=Frameleaf', Connect.messageOf(err), 'critical') end
  end)
end

local function disconnect(props)
  LrTasks.startAsyncTask(function()
    local library = Util.normalizeLibraryUrl(props.libraryUrl)
    if library then Connect.disconnect(library) end
    refreshStatus(props)
  end)
end

function provider.startDialog(props)
  refreshStatus(props)
  props:addObserver('libraryUrl', function() refreshStatus(props) end)
end

function provider.sectionsForTopOfDialog(f, props)
  return {
    {
      title = LOC '$$$/Frameleaf/Section/Title=Frameleaf Library',
      synopsis = bind { key = 'status', object = props },
      f:row {
        f:static_text { title = LOC '$$$/Frameleaf/Library/Label=Library address:', alignment = 'right', width = LrView.share 'label' },
        f:edit_field { value = bind 'libraryUrl', width_in_chars = 32, immediate = false, enabled = LrView.negativeOfKey 'connected' },
      },
      f:row {
        f:spacer { width = LrView.share 'label' },
        f:static_text { title = LOC '$$$/Frameleaf/Library/Hint=For example https://photos.example.com or http://192.168.1.20:2283', size = 'small' },
      },
      f:row {
        f:static_text { title = LOC '$$$/Frameleaf/ClientId/Label=App ID (optional):', alignment = 'right', width = LrView.share 'label' },
        f:edit_field { value = bind 'clientId', width_in_chars = 32, enabled = LrView.negativeOfKey 'connected' },
      },
      f:row {
        f:spacer { width = LrView.share 'label' },
        f:static_text { title = LOC '$$$/Frameleaf/ClientId/Hint=Only needed if your administrator registered Lightroom for you.', size = 'small' },
      },
      f:row {
        f:spacer { width = LrView.share 'label' },
        f:checkbox { title = LOC '$$$/Frameleaf/Tags/Checkbox=Add Lightroom keywords as Frameleaf tags', value = bind 'addKeywordTags' },
      },
      f:row {
        f:spacer { width = LrView.share 'label' },
        f:checkbox { title = LOC '$$$/Frameleaf/Location/Checkbox=Include location', value = bind 'includeLocation' },
      },
      f:row {
        f:spacer { width = LrView.share 'label' },
        f:static_text { title = bind 'status', fill_horizontal = 1 },
        f:push_button {
          title = LOC '$$$/Frameleaf/Connect/Button=Connect…',
          enabled = LrView.bind {
            keys = { 'connected', 'busy' },
            operation = function(_, values) return not values.connected and not values.busy end,
          },
          action = function() connect(props) end,
        },
        f:push_button {
          title = LOC '$$$/Frameleaf/Disconnect/Button=Disconnect',
          enabled = bind 'connected',
          action = function() disconnect(props) end,
        },
      },
      f:row {
        f:spacer { width = LrView.share 'label' },
        f:static_text {
          title = LOC '$$$/Frameleaf/Copies/Note=Frameleaf keeps every copy you publish. Republishing an edited photo adds a new copy, and removing a photo from a collection never removes it from Frameleaf.',
          width_in_chars = 48,
          height_in_lines = 3,
          size = 'small',
        },
      },
    },
  }
end

---------------------------------------------------------------------------
-- Collections map to albums
---------------------------------------------------------------------------

function provider.getCollectionBehaviorInfo()
  return {
    defaultCollectionName = LOC '$$$/Frameleaf/DefaultCollection=Frameleaf',
    defaultCollectionCanBeDeleted = true,
    canAddCollection = true,
    maxCollectionSetDepth = 0,
  }
end

function provider.viewForCollectionSettings(f, publishSettings, info)
  local settings = info.collectionSettings
  if settings.albumId == nil then settings.albumId = '' end
  settings.albumItems = { { title = LOC '$$$/Frameleaf/Album/CreateNew=Create a new album', value = '' } }
  LrTasks.startAsyncTask(function()
    local library = Util.normalizeLibraryUrl(publishSettings.libraryUrl)
    local ok, albums = LrTasks.pcall(function() return Connect.writableAlbums(Connect.session(library)) end)
    if not ok then return end
    local items = { { title = LOC '$$$/Frameleaf/Album/CreateNew=Create a new album', value = '' } }
    for _, album in ipairs(albums) do items[#items + 1] = { title = album.name, value = album.id } end
    settings.albumItems = items
  end)
  return f:row {
    bind_to_object = settings,
    f:static_text { title = LOC '$$$/Frameleaf/Album/Label=Frameleaf album:' },
    f:popup_menu { value = bind 'albumId', items = bind 'albumItems', width_in_chars = 28 },
  }
end

local function albumFor(conn, exportContext)
  local collection = exportContext.publishedCollection
  local info = exportContext.publishedCollectionInfo
  local chosen = (collection:getCollectionInfoSummary().collectionSettings or {}).albumId
  if chosen and chosen ~= '' then return chosen end
  if info.remoteId then return info.remoteId end
  local ok, album = LrTasks.pcall(Connect.createAlbum, conn, info.name, collection.localIdentifier)
  if not ok then
    if Connect.kindOf(album) == 'forbidden' then
      Connect.fail(LOC '$$$/Frameleaf/Error/NoAlbum=This connection can’t create albums. Choose an album in the collection’s settings, or disconnect and connect again allowing new albums.')
    end
    error(album, 0)
  end
  return album.id
end

---------------------------------------------------------------------------
-- Publish
---------------------------------------------------------------------------

function provider.processRenderedPhotos(functionContext, exportContext)
  local session = exportContext.exportSession
  local settings = exportContext.propertyTable
  local library = Util.normalizeLibraryUrl(settings.libraryUrl)
  local count = session:countRenditions()
  local progress = exportContext:configureProgress { title = LOC '$$$/Frameleaf/Progress=Publishing to Frameleaf' }

  local ok, err = LrTasks.pcall(function()
    local conn = Connect.session(library)
    local caps = Connect.capabilities(conn)
    local albumId = albumFor(conn, exportContext)
    session:recordRemoteCollectionId(albumId)
    session:recordRemoteCollectionUrl(library .. '/albums/' .. albumId)

    local tagFailures = 0
    for i, rendition in session:renditions { stopIfCanceled = true } do
      progress:setPortionComplete((i - 1) / count)
      local rendered, path = rendition:waitForRender()
      if not rendered then
        rendition:uploadFailed(path)
      else
        local photo = rendition.photo
        local captured = photo:getRawMetadata('dateTimeOriginal')
        local uploaded, result = LrTasks.pcall(Connect.upload, conn, {
          path = path,
          albumId = albumId,
          limits = caps and caps.limits,
          localIdentifier = photo.localIdentifier,
          capturedAt = captured and Util.isoFromCocoa(captured) or nil,
          isCanceled = function() return progress:isCanceled() end,
          progress = function(done) progress:setPortionComplete((i - 1 + done) / count) end,
        })
        LrFileUtils.delete(path)
        if uploaded then
          rendition:recordPublishedPhotoId(result.assetId)
          rendition:recordPublishedPhotoUrl(library .. '/photos/' .. result.assetId)
          if settings.addKeywordTags then
            local tags = Util.keywordTags(photo:getFormattedMetadata('keywordTagsForExport'))
            if not LrTasks.pcall(Connect.addTags, conn, result.assetId, tags) then tagFailures = tagFailures + 1 end
          end
        else
          local kind = Connect.kindOf(result)
          if kind == 'reconnect' or kind == 'canceled' then error(result, 0) end
          rendition:uploadFailed(Connect.messageOf(result))
        end
      end
    end
    if tagFailures > 0 then
      LrDialogs.message(LOC '$$$/Frameleaf/Title=Frameleaf',
        LOC('$$$/Frameleaf/Warning/Tags=Photos were published, but keywords couldn’t be added as tags to ^1 of them. Disconnect and connect again allowing tags, then republish.', tostring(tagFailures)),
        'warning')
    end
  end)
  progress:done()
  if not ok and Connect.kindOf(err) ~= 'canceled' then
    LrDialogs.message(LOC '$$$/Frameleaf/Title=Frameleaf', Connect.messageOf(err), 'critical')
  end
end

-- Removing photos from a collection only forgets them in Lightroom. Frameleaf keeps its copies.
function provider.deletePhotosFromPublishedCollection(publishSettings, photoIds, deletedCallback)
  for _, id in ipairs(photoIds) do deletedCallback(id) end
  LrDialogs.messageWithDoNotShow {
    message = LOC '$$$/Frameleaf/Removed/Message=Removed from this collection only',
    info = LOC '$$$/Frameleaf/Removed/Info=The photos stay in Frameleaf. Remove them there if you no longer want them.',
    actionPrefKey = 'frameleafRemovedKeepsCopies',
  }
end

function provider.deletePublishedCollection(publishSettings, info)
  LrDialogs.messageWithDoNotShow {
    message = LOC '$$$/Frameleaf/Removed/Message=Removed from this collection only',
    info = LOC '$$$/Frameleaf/Removed/Info=The photos stay in Frameleaf. Remove them there if you no longer want them.',
    actionPrefKey = 'frameleafRemovedKeepsCopies',
  }
end

return provider
