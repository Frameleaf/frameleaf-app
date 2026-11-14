-- Connect.lua against a fake Lightroom SDK and a fake Library.
package.path = 'frameleaf.lrplugin/?.lua;' .. package.path
local Util = require('Util')

local logged, passwords, prefs, opened, server

_G.LOC = function(s, ...)
  local args = { ... }
  return (s:gsub('^%$%$%$/[^=]*=', ''):gsub('%^(%d)', function(n) return tostring(args[tonumber(n)]) end))
end

local function headerValue(headers, name)
  for _, h in ipairs(headers or {}) do
    if h.field:lower() == name:lower() then return h.value end
  end
end

local sdk = {
  LrHttp = {
    get = function(url, headers) return server('GET', url, nil, headers) end,
    post = function(url, body, headers, method) return server(method or 'POST', url, body, headers) end,
    openUrlInBrowser = function(url) opened = url end,
  },
  LrPasswords = {
    store = function(k, v) passwords[k] = v end,
    retrieve = function(k) return passwords[k] end,
  },
  LrPrefs = { prefsForPlugin = function() return prefs end },
  LrTasks = {
    sleep = function() end,
    pcall = pcall,
    execute = function(cmd) return os.execute(cmd) == true and 0 or 0 end,
  },
  LrUUID = { generateUUID = function() return string.format('%08x-aaaa-4bbb-8ccc-%012x', math.random(0, 2 ^ 31), math.random(0, 2 ^ 40)) end },
  LrLogger = function()
    return { enable = function() end, warn = function(_, m) logged[#logged + 1] = m end }
  end,
  LrFileUtils = {
    chooseUniqueFileName = function(p) return p end,
    readFile = function(p) local f = io.open(p, 'rb'); if not f then return nil end; local t = f:read('*a'); f:close(); return t end,
    delete = function(p) os.remove(p) end,
    fileAttributes = function(p) local f = io.open(p, 'rb'); local n = f:seek('end'); f:close(); return { fileSize = n } end,
  },
  LrPathUtils = {
    child = function(a, b) return a .. '/' .. b end,
    getStandardFilePath = function() return os.getenv('TMPDIR') or '/tmp' end,
  },
}
_G.import = function(name) return assert(sdk[name], name) end

local function respond(status, body, extra)
  local headers = extra or {}
  headers.status = status
  return body and Util.encodeJson(body) or '', headers
end

local LIB = 'https://photos.example.test'

local function reload()
  package.loaded.Connect = nil
  passwords, prefs, logged = {}, {}, {}
  return require('Connect')
end

describe('Connect', function()
  local Connect, tokens, refreshes

  local function connected()
    passwords['net.frameleaf.connect:' .. LIB] = Util.encodeJson({
      clientId = 'client-1', accessToken = 'access-0', refreshToken = 'refresh-0', expiresAt = os.time() + 600,
      resource = LIB .. '/api/connect', tokenEndpoint = LIB .. '/api/oauth/apps/token',
    })
  end

  before_each(function()
    Connect = reload()
    tokens, refreshes = { access = 'access-0', refresh = 'refresh-0' }, 0
  end)

  -- Token endpoint shared by the tests: rotates on every refresh, rejects reuse.
  local function tokenEndpoint(body)
    local q = Util.parseQuery('?' .. body)
    if q.grant_type == 'refresh_token' then
      if q.refresh_token ~= tokens.refresh then return respond(400, { error = 'invalid_grant' }) end
      refreshes = refreshes + 1
      tokens.access, tokens.refresh = 'access-' .. refreshes, 'refresh-' .. refreshes
      return respond(200, { access_token = tokens.access, refresh_token = tokens.refresh, expires_in = 600 })
    end
    return respond(200, { access_token = 'access-0', refresh_token = 'refresh-0', expires_in = 600, scope = q.scope })
  end

  it('signs in with PKCE, rejects a replayed callback and never logs secrets', function()
    local seen
    server = function(method, url, body)
      if url == LIB .. '/.well-known/oauth-protected-resource/api/connect' then
        return respond(200, { resource = LIB .. '/api/connect' })
      elseif url == LIB .. '/.well-known/oauth-authorization-server' then
        return respond(200, {
          issuer = LIB,
          authorization_endpoint = LIB .. '/api/oauth/apps/authorize',
          token_endpoint = LIB .. '/api/oauth/apps/token',
          registration_endpoint = LIB .. '/api/oauth/apps/register',
          revocation_endpoint = LIB .. '/api/oauth/apps/revoke',
        })
      elseif url:find('/register$') then
        local reg = Util.decodeJson(body)
        assert.are.same({ Connect.CALLBACK }, reg.redirect_uris)
        assert.are.equal('none', reg.token_endpoint_auth_method)
        return respond(201, { client_id = 'client-1' })
      elseif url:find('/token$') then
        seen = Util.parseQuery('?' .. body)
        return tokenEndpoint(body)
      end
      error('unexpected ' .. method .. ' ' .. url)
    end

    Connect.beginSignIn(LIB, '', true)
    local auth = Util.parseQuery(opened)
    assert.are.equal('S256', auth.code_challenge_method)
    assert.are.equal(Connect.CALLBACK, auth.redirect_uri)
    assert.are.equal(LIB .. '/api/connect', auth.resource)
    assert.truthy(auth.scope:find('tags:write', 1, true))

    local ok = Connect.finishSignIn(Connect.CALLBACK .. '?code=abc&state=' .. auth.state .. '&iss=' .. Util.urlEncode(LIB))
    assert.is_true(ok)
    assert.are.equal(auth.code_challenge, Util.pkceChallenge(seen.code_verifier))
    assert.are.equal('client-1', seen.client_id)
    assert.is_true(Connect.isConnected(LIB))
    assert.is_true(Connect.waitForSignIn(LIB))

    local replay = Connect.finishSignIn(Connect.CALLBACK .. '?code=abc&state=' .. auth.state)
    assert.is_false(replay)
    for _, line in ipairs(logged) do assert.is_nil(line:find('access-', 1, true)) end
  end)

  it('rejects a callback with the wrong state', function()
    prefs.pendingSignIn = Util.encodeJson({ state = 'expected', startedAt = os.time() })
    local ok, message = Connect.finishSignIn(Connect.CALLBACK .. '?code=x&state=other')
    assert.is_false(ok)
    assert.truthy(message:find('expired', 1, true))
    assert.is_not_nil(prefs.pendingSignIn)
  end)

  it('refreshes once on 401, stores the rotated pair and retries', function()
    connected()
    server = function(method, url, body, headers)
      if url:find('/token$') then return tokenEndpoint(body) end
      if headerValue(headers, 'Authorization') ~= 'Bearer ' .. tokens.access then return respond(401, { message = 'expired' }) end
      return respond(200, { items = { { id = 'a1', name = 'B', workspace = 'photo', canWrite = true }, { id = 'a2', name = 'a', workspace = 'both', canWrite = false } } })
    end
    tokens.access = 'access-server-side-changed'
    local albums = Connect.writableAlbums(Connect.session(LIB))
    assert.are.equal(1, #albums)
    assert.are.equal(1, refreshes)
    local stored = Util.decodeJson(passwords['net.frameleaf.connect:' .. LIB])
    assert.are.equal('refresh-1', stored.refreshToken)
  end)

  it('drops the connection when the refresh token is refused', function()
    connected()
    tokens.refresh = 'someone-else'
    server = function(_, url, body)
      if url:find('/token$') then return tokenEndpoint(body) end
      return respond(401, {})
    end
    local ok, err = pcall(Connect.api, Connect.session(LIB), 'GET', 'albums')
    assert.is_false(ok)
    assert.are.equal('reconnect', Connect.kindOf(err))
    assert.is_false(Connect.isConnected(LIB))
  end)

  it('uploads in chunks, resumes from the durable offset after a failure, then commits', function()
    connected()
    local path = os.tmpname()
    local content = string.rep('0123456789', 5) -- 50 bytes
    local f = io.open(path, 'wb'); f:write(content); f:close()
    local received, failedOnce, start, commit = '', false, nil, nil

    server = function(method, url, body, headers)
      local state = function() return { id = 'u1', offset = #received, size = #content, state = 'receiving', expiresAt = 'x' } end
      if method == 'POST' and url:find('/uploads$') then
        start = Util.decodeJson(body)
        return respond(201, state())
      elseif method == 'PATCH' then
        assert.are.equal(tostring(#received), headerValue(headers, 'Upload-Offset'))
        assert.are.equal('application/partial-upload', headerValue(headers, 'Content-Type'))
        if #received == 20 and not failedOnce then
          failedOnce = true
          received = received .. body:sub(1, 5) -- server kept part of the chunk
          return '', { error = { name = 'timedOut' } }
        end
        received = received .. body
        return respond(200, state())
      elseif method == 'GET' and url:find('/uploads/u1$') then
        return respond(200, state())
      elseif method == 'POST' and url:find('/commit$') then
        commit = Util.decodeJson(body)
        return respond(200, { assetId = 'asset-1', status = 'created', sha256 = commit.sha256 })
      end
      error('unexpected ' .. method .. ' ' .. url)
    end

    local receipt = Connect.upload(Connect.session(LIB), {
      path = path, albumId = 'album-1', localIdentifier = 77, limits = { maxAppendBytes = 10 },
      capturedAt = '2024-05-01T10:00:00Z',
    })
    os.remove(path)
    assert.is_true(failedOnce)
    assert.are.equal('asset-1', receipt.assetId)
    assert.are.equal(content, received)
    assert.are.equal(Util.sha256Hex(content), start.sha256)
    assert.are.equal('lr-77-' .. start.sha256, start.requestId)
    assert.are.same({ requestId = start.requestId, sha256 = start.sha256 }, commit)
    assert.are.equal('image/jpeg', start.contentType)
    assert.are.equal('photo', start.workspace)
  end)

  it('reuses a committed receipt when the same bytes are published again', function()
    connected()
    local path = os.tmpname()
    local f = io.open(path, 'wb'); f:write('same'); f:close()
    local calls = 0
    server = function(method)
      calls = calls + 1
      assert.are.equal('POST', method)
      return respond(201, { id = 'u1', offset = 4, size = 4, state = 'published', expiresAt = 'x', receipt = { assetId = 'asset-9', status = 'duplicate', sha256 = 'x' } })
    end
    local receipt = Connect.upload(Connect.session(LIB), { path = path, albumId = 'a', localIdentifier = 1 })
    os.remove(path)
    assert.are.equal('asset-9', receipt.assetId)
    assert.are.equal(1, calls)
  end)
end)
