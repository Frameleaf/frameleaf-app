-- Frameleaf Connect client: discovery, OAuth (PKCE S256), token storage and resumable uploads.
-- Never log tokens, codes, authorization headers, transfer URLs or file names.

local LrFileUtils = import 'LrFileUtils'
local LrHttp = import 'LrHttp'
local LrLogger = import 'LrLogger'
local LrPasswords = import 'LrPasswords'
local LrPathUtils = import 'LrPathUtils'
local LrPrefs = import 'LrPrefs'
local LrTasks = import 'LrTasks'
local LrUUID = import 'LrUUID'

local Util = require 'Util'

local log = LrLogger('Frameleaf')
log:enable('logfile')

local Connect = {}

Connect.CALLBACK = 'lightroom://net.frameleaf.connect/oauth/callback'
Connect.CLIENT_NAME = 'Frameleaf for Lightroom Classic'
local TIMEOUT = 60
local PENDING_SECONDS = 15 * 60

local prefs = LrPrefs.prefsForPlugin()

---------------------------------------------------------------------------
-- Errors carry a user-facing message; callers show them with LrDialogs.
---------------------------------------------------------------------------

local ConnectError = {}
ConnectError.__index = ConnectError
ConnectError.__tostring = function(e) return e.message end

local function fail(message, kind)
  error(setmetatable({ message = message, kind = kind }, ConnectError), 0)
end
Connect.fail = fail

function Connect.messageOf(err)
  if type(err) == 'table' and err.message then return err.message end
  return tostring(err)
end

function Connect.kindOf(err)
  return type(err) == 'table' and err.kind or nil
end

---------------------------------------------------------------------------
-- HTTP
---------------------------------------------------------------------------

local function header(headers, name)
  if type(headers) ~= 'table' then return nil end
  name = name:lower()
  for _, h in ipairs(headers) do
    if type(h) == 'table' and h.field and h.field:lower() == name then return h.value end
  end
  return nil
end

local function decode(body)
  if type(body) ~= 'string' or body == '' then return nil end
  local ok, value = pcall(Util.decodeJson, body)
  return ok and value or nil
end

-- One HTTP exchange. Returns status, decoded JSON (or nil), raw headers. Network failures raise.
local function exchange(method, url, body, headers)
  local resBody, resHeaders
  if method == 'GET' then
    resBody, resHeaders = LrHttp.get(url, headers, TIMEOUT)
  else
    resBody, resHeaders = LrHttp.post(url, body or '', headers, method, TIMEOUT, body and #body or 0)
  end
  if type(resHeaders) ~= 'table' or not resHeaders.status then
    local reason = type(resHeaders) == 'table' and resHeaders.error and resHeaders.error.name or 'no response'
    log:warn(method .. ' failed: ' .. tostring(reason))
    fail(LOC('$$$/Frameleaf/Error/Network=Frameleaf couldn’t reach your Library. Check the address and that this computer can reach it.'), 'network')
  end
  return resHeaders.status, decode(resBody), resHeaders
end

local function serverMessage(status, data)
  local detail = type(data) == 'table' and (data.error_description or data.message) or nil
  if type(detail) == 'table' then detail = detail[1] end
  if type(detail) == 'string' and detail ~= '' then return detail end
  return LOC('$$$/Frameleaf/Error/Server=Frameleaf answered with error ^1.', tostring(status))
end

---------------------------------------------------------------------------
-- Connection storage: secrets in the OS keychain via LrPasswords, nothing secret in prefs.
---------------------------------------------------------------------------

local function secretKey(library) return 'net.frameleaf.connect:' .. library end

function Connect.load(library)
  if not library then return nil end
  local raw = LrPasswords.retrieve(secretKey(library))
  local conn = decode(raw)
  if type(conn) ~= 'table' or not conn.refreshToken then return nil end
  conn.library = library
  return conn
end

local function save(conn)
  LrPasswords.store(secretKey(conn.library), Util.encodeJson({
    clientId = conn.clientId,
    accessToken = conn.accessToken,
    refreshToken = conn.refreshToken,
    expiresAt = conn.expiresAt,
    resource = conn.resource,
    scope = conn.scope,
    tokenEndpoint = conn.tokenEndpoint,
    revocationEndpoint = conn.revocationEndpoint,
  }))
end

local function forget(library)
  LrPasswords.store(secretKey(library), '')
end

function Connect.isConnected(library)
  return Connect.load(library) ~= nil
end

---------------------------------------------------------------------------
-- Discovery and registration
---------------------------------------------------------------------------

local function discover(library)
  local status, resource = exchange('GET', library .. '/.well-known/oauth-protected-resource/api/connect', nil, {})
  if status ~= 200 or type(resource) ~= 'table' or type(resource.resource) ~= 'string' then
    fail(LOC('$$$/Frameleaf/Error/NotLibrary=This address isn’t a Frameleaf Library that supports Lightroom. Check the address, and ask your administrator to update Frameleaf if it is.'))
  end
  local status2, server = exchange('GET', library .. '/.well-known/oauth-authorization-server', nil, {})
  if status2 ~= 200 or type(server) ~= 'table' or not server.authorization_endpoint or not server.token_endpoint then
    fail(LOC('$$$/Frameleaf/Error/NotLibrary=This address isn’t a Frameleaf Library that supports Lightroom. Check the address, and ask your administrator to update Frameleaf if it is.'))
  end
  return resource.resource, server
end

local function clientIds()
  return decode(prefs.clientIds) or {}
end

local function register(library, server)
  local known = clientIds()[library]
  if known then return known end
  if not server.registration_endpoint then
    fail(LOC('$$$/Frameleaf/Error/Registration=This Library doesn’t let apps register themselves. Ask its administrator to register Lightroom, then enter the app ID they give you.'))
  end
  local body = Util.encodeJson({
    client_name = Connect.CLIENT_NAME,
    redirect_uris = { Connect.CALLBACK },
    grant_types = { 'authorization_code', 'refresh_token' },
    response_types = { 'code' },
    token_endpoint_auth_method = 'none',
  })
  local status, data = exchange('POST', server.registration_endpoint, body, { { field = 'Content-Type', value = 'application/json' } })
  if status == 403 then
    fail(LOC('$$$/Frameleaf/Error/Registration=This Library doesn’t let apps register themselves. Ask its administrator to register Lightroom, then enter the app ID they give you.'))
  end
  if (status ~= 200 and status ~= 201) or type(data) ~= 'table' or not data.client_id then
    fail(serverMessage(status, data))
  end
  local ids = clientIds()
  ids[library] = data.client_id
  prefs.clientIds = Util.encodeJson(ids)
  return data.client_id
end

---------------------------------------------------------------------------
-- Sign-in: open the consent page; URLHandler.lua finishes it.
---------------------------------------------------------------------------

local function scopes(wantTags)
  local list = 'library:read albums:write photos:upload'
  if wantTags then list = list .. ' tags:write' end
  return list
end

function Connect.beginSignIn(library, manualClientId, wantTags)
  local resource, server = discover(library)
  local clientId = (manualClientId and manualClientId:match('%S') and manualClientId:match('^%s*(.-)%s*$')) or register(library, server)
  -- Two v4 UUIDs: 64 characters of OS randomness, within PKCE's unreserved set.
  local verifier = (LrUUID.generateUUID() .. LrUUID.generateUUID()):gsub('-', '')
  local state = LrUUID.generateUUID()
  prefs.pendingSignIn = Util.encodeJson({
    library = library,
    clientId = clientId,
    resource = resource,
    scope = scopes(wantTags),
    tokenEndpoint = server.token_endpoint,
    revocationEndpoint = server.revocation_endpoint,
    issuer = server.issuer,
    verifier = verifier,
    state = state,
    startedAt = os.time(),
  })
  prefs.signInStatus = 'waiting'
  local url = server.authorization_endpoint .. '?' .. Util.formEncode({
    response_type = 'code',
    client_id = clientId,
    redirect_uri = Connect.CALLBACK,
    scope = scopes(wantTags),
    resource = resource,
    state = state,
    code_challenge = Util.pkceChallenge(verifier),
    code_challenge_method = 'S256',
  })
  LrHttp.openUrlInBrowser(url)
end

-- Called from URLHandler with the callback URL. Returns true, or false and a message.
function Connect.finishSignIn(url)
  local pending = decode(prefs.pendingSignIn)
  local q = Util.parseQuery(url)
  local expired = LOC('$$$/Frameleaf/Error/State=That sign-in has expired. Start connecting again from Lightroom.')
  if type(pending) ~= 'table' or q.state ~= pending.state or os.time() - (pending.startedAt or 0) > PENDING_SECONDS then
    return false, expired
  end
  -- Single use: a replayed callback finds nothing pending.
  prefs.pendingSignIn = nil
  prefs.signInStatus = 'exchanging'
  local ok, err = LrTasks.pcall(function()
    if q.iss and pending.issuer and q.iss ~= pending.issuer then fail(expired) end
    if q.error == 'access_denied' then
      fail(LOC('$$$/Frameleaf/Error/Denied=Lightroom wasn’t connected because access wasn’t allowed.'))
    end
    if q.error then fail(LOC('$$$/Frameleaf/Error/Consent=Frameleaf didn’t connect: ^1', q.error_description or q.error)) end
    if not q.code then fail(expired) end
    local status, data = exchange('POST', pending.tokenEndpoint, Util.formEncode({
      grant_type = 'authorization_code',
      code = q.code,
      redirect_uri = Connect.CALLBACK,
      client_id = pending.clientId,
      code_verifier = pending.verifier,
      resource = pending.resource,
    }), { { field = 'Content-Type', value = 'application/x-www-form-urlencoded' } })
    if status ~= 200 or type(data) ~= 'table' or not data.access_token or not data.refresh_token then
      fail(serverMessage(status, data))
    end
    save({
      library = pending.library,
      clientId = pending.clientId,
      accessToken = data.access_token,
      refreshToken = data.refresh_token,
      expiresAt = os.time() + (tonumber(data.expires_in) or 300),
      resource = pending.resource,
      scope = data.scope or pending.scope,
      tokenEndpoint = pending.tokenEndpoint,
      revocationEndpoint = pending.revocationEndpoint,
    })
  end)
  prefs.signInStatus = ok and ('connected:' .. pending.library) or 'failed'
  if not ok then return false, Connect.messageOf(err) end
  return true
end

-- Yields until URLHandler finishes; true when connected, false on failure or timeout.
function Connect.waitForSignIn(library)
  local deadline = os.time() + PENDING_SECONDS
  while os.time() < deadline do
    local status = prefs.signInStatus
    if status == 'connected:' .. library then prefs.signInStatus = nil; return true end
    if status ~= 'waiting' and status ~= 'exchanging' then return false end
    LrTasks.sleep(1)
  end
  return false
end

function Connect.disconnect(library)
  local conn = Connect.load(library)
  forget(library)
  if conn and conn.revocationEndpoint then
    -- Revocation accepts a consumed refresh token for the same grant; failures still leave Lightroom signed out.
    LrTasks.pcall(exchange, 'POST', conn.revocationEndpoint, Util.formEncode({ client_id = conn.clientId, token = conn.refreshToken }),
      { { field = 'Content-Type', value = 'application/x-www-form-urlencoded' } })
  end
end

---------------------------------------------------------------------------
-- Tokens. Refresh tokens rotate and reuse revokes the grant, so refreshes are serialized
-- and always start from the newest stored pair.
---------------------------------------------------------------------------

local refreshing = false

local function refresh(conn)
  while refreshing do LrTasks.sleep(0.2) end
  local stored = Connect.load(conn.library)
  if not stored then fail(LOC('$$$/Frameleaf/Error/Reconnect=Your connection to Frameleaf has ended. Open the publish service settings and connect again.'), 'reconnect') end
  if stored.refreshToken ~= conn.refreshToken then
    for k, v in pairs(stored) do conn[k] = v end
    return
  end
  refreshing = true
  local ok, err = LrTasks.pcall(function()
    local status, data = exchange('POST', conn.tokenEndpoint, Util.formEncode({
      grant_type = 'refresh_token',
      refresh_token = conn.refreshToken,
      client_id = conn.clientId,
      resource = conn.resource,
    }), { { field = 'Content-Type', value = 'application/x-www-form-urlencoded' } })
    if status == 400 or status == 401 then
      forget(conn.library)
      fail(LOC('$$$/Frameleaf/Error/Reconnect=Your connection to Frameleaf has ended. Open the publish service settings and connect again.'), 'reconnect')
    end
    if status ~= 200 or type(data) ~= 'table' or not data.access_token or not data.refresh_token then
      fail(serverMessage(status, data))
    end
    conn.accessToken = data.access_token
    conn.refreshToken = data.refresh_token
    conn.expiresAt = os.time() + (tonumber(data.expires_in) or 300)
    save(conn)
  end)
  refreshing = false
  if not ok then error(err, 0) end
end

function Connect.session(library)
  local conn = Connect.load(library)
  if not conn then
    fail(LOC('$$$/Frameleaf/Error/NotConnected=Connect Lightroom to your Library in the publish service settings first.'), 'reconnect')
  end
  return conn
end

-- Authenticated Connect API call. path is relative to /api/connect.
function Connect.api(conn, method, path, body, extraHeaders, rawBody)
  if (conn.expiresAt or 0) - 30 < os.time() then refresh(conn) end
  local payload = rawBody or (body ~= nil and Util.encodeJson(body) or nil)
  for attempt = 1, 6 do
    local headers = { { field = 'Authorization', value = 'Bearer ' .. conn.accessToken } }
    if body ~= nil then headers[#headers + 1] = { field = 'Content-Type', value = 'application/json' } end
    for _, h in ipairs(extraHeaders or {}) do headers[#headers + 1] = h end
    local status, data, resHeaders = exchange(method, conn.library .. '/api/connect/' .. path, payload, headers)
    if status == 401 and attempt == 1 then
      refresh(conn)
    elseif status == 409 and attempt < 6 then
      -- Album hierarchy or access is changing; retry the same request ID and payload.
      LrTasks.sleep(2 * attempt)
    else
      if status == 401 then
        fail(LOC('$$$/Frameleaf/Error/Reconnect=Your connection to Frameleaf has ended. Open the publish service settings and connect again.'), 'reconnect')
      end
      if status == 403 then
        fail(LOC('$$$/Frameleaf/Error/Forbidden=This connection isn’t allowed to do that: ^1', serverMessage(status, data)), 'forbidden')
      end
      if status >= 400 then fail(serverMessage(status, data), 'http') end
      return data, status, resHeaders
    end
  end
  fail(LOC('$$$/Frameleaf/Error/Busy=Frameleaf is busy. Try again in a moment.'), 'busy')
end

function Connect.writableAlbums(conn)
  local data = Connect.api(conn, 'GET', 'albums')
  local out = {}
  for _, album in ipairs(type(data) == 'table' and data.items or {}) do
    if album.canWrite and album.workspace == 'photo' then out[#out + 1] = album end
  end
  table.sort(out, function(a, b) return (a.name or ''):lower() < (b.name or ''):lower() end)
  return out
end

function Connect.createAlbum(conn, name, collectionId)
  local album = Connect.api(conn, 'POST', 'albums', {
    requestId = Util.albumRequestId(collectionId),
    name = name,
    workspace = 'photo',
  })
  if type(album) ~= 'table' or not album.id then fail(serverMessage(500, album)) end
  return album
end

---------------------------------------------------------------------------
-- Upload
---------------------------------------------------------------------------

-- SHA-256 of a file using the OS (shasum on macOS, certutil on Windows).
function Connect.fileSha256(path)
  local out = LrFileUtils.chooseUniqueFileName(LrPathUtils.child(LrPathUtils.getStandardFilePath('temp'), 'frameleaf-sha.txt'))
  local cmd
  if WIN_ENV then
    cmd = '"certutil -hashfile "' .. path .. '" SHA256 > "' .. out .. '""'
  else
    cmd = "/usr/bin/shasum -a 256 '" .. path:gsub("'", "'\\''") .. "' > '" .. out:gsub("'", "'\\''") .. "'"
  end
  local status = LrTasks.execute(cmd)
  local text = LrFileUtils.readFile(out)
  LrFileUtils.delete(out)
  local digest = status == 0 and Util.parseDigest(text) or nil
  if not digest then fail(LOC('$$$/Frameleaf/Error/Hash=Lightroom couldn’t check the exported file.')) end
  return digest
end

local function readChunk(path, offset, length)
  local f = io.open(path, 'rb')
  if not f then fail(LOC('$$$/Frameleaf/Error/Hash=Lightroom couldn’t check the exported file.')) end
  f:seek('set', offset)
  local data = f:read(length)
  f:close()
  return data or ''
end

-- Uploads one rendered JPEG into albumId. Returns the receipt { assetId, status }.
function Connect.upload(conn, opts)
  local path, limits = opts.path, opts.limits or {}
  local size = LrFileUtils.fileAttributes(path).fileSize
  if limits.maxUploadBytes and size > limits.maxUploadBytes then
    fail(LOC('$$$/Frameleaf/Error/TooLarge=This photo is larger than your Library accepts. Export it smaller and try again.'))
  end
  local sha = Connect.fileSha256(path)
  local requestId = Util.requestId(opts.localIdentifier, sha)
  local state = Connect.api(conn, 'POST', 'uploads', {
    requestId = requestId,
    albumId = opts.albumId,
    workspace = 'photo',
    filename = Util.uploadFilename(path),
    size = size,
    sha256 = sha,
    contentType = 'image/jpeg',
    fileCreatedAt = opts.capturedAt or Util.isoUtc(os.time()),
    fileModifiedAt = Util.isoUtc(os.time()),
  })
  if state.receipt then return state.receipt end

  local chunkSize = math.min(tonumber(limits.maxAppendBytes) or 8388608, 8388608)
  local offset, failures = tonumber(state.offset) or 0, 0
  while offset < size and state.state == 'receiving' do
    if opts.isCanceled and opts.isCanceled() then
      LrTasks.pcall(Connect.api, conn, 'DELETE', 'uploads/' .. state.id)
      fail(LOC('$$$/Frameleaf/Error/Canceled=Publishing was canceled.'), 'canceled')
    end
    local length = math.min(chunkSize, size - offset)
    local last = offset + length >= size
    local ok, result = LrTasks.pcall(Connect.api, conn, 'PATCH', 'uploads/' .. state.id, nil, {
      { field = 'Content-Type', value = 'application/partial-upload' },
      { field = 'Upload-Draft-Interop-Version', value = '9' },
      { field = 'Upload-Offset', value = string.format('%d', offset) },
      { field = 'Upload-Complete', value = last and '?1' or '?0' },
    }, readChunk(path, offset, length))
    if ok and type(result) == 'table' then
      state = result
      failures = 0
    else
      local kind = Connect.kindOf(result)
      failures = failures + 1
      if kind == 'reconnect' or kind == 'forbidden' or failures > 3 then error(result, 0) end
      LrTasks.sleep(2 * failures)
      -- Resume from the server's durable offset.
      state = Connect.api(conn, 'GET', 'uploads/' .. state.id)
    end
    offset = tonumber(state.offset) or offset
    if opts.progress then opts.progress(offset / size) end
  end
  if state.receipt then return state.receipt end
  local receipt = Connect.api(conn, 'POST', 'uploads/' .. state.id .. '/commit', { requestId = requestId, sha256 = sha })
  if type(receipt) ~= 'table' or not receipt.assetId then fail(serverMessage(500, receipt)) end
  return receipt
end

function Connect.addTags(conn, assetId, tags)
  if #tags == 0 then return end
  Connect.api(conn, 'POST', 'assets/' .. assetId .. '/tags', { tags = tags })
end

function Connect.capabilities(conn)
  return Connect.api(conn, 'GET', 'capabilities')
end

return Connect
