-- Pure helpers with no Lightroom imports, so they run under busted (see spec/).
-- Lightroom Classic runs Lua 5.1; everything here also runs on 5.2-5.4.

local Util = {}

local floor = math.floor

---------------------------------------------------------------------------
-- JSON (only what the Connect protocol needs)
---------------------------------------------------------------------------

Util.null = setmetatable({}, { __tostring = function() return 'null' end })
Util.emptyArray = setmetatable({}, { __tostring = function() return '[]' end })

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }

local function encodeString(s)
  return '"' .. s:gsub('[%c"\\]', function(c)
    return escapes[c] or string.format('\\u%04x', c:byte())
  end) .. '"'
end

local function isArray(t)
  if t == Util.emptyArray then return true end
  local n = #t
  if n == 0 then return false end
  for k in pairs(t) do
    if type(k) ~= 'number' or k < 1 or k > n or k ~= floor(k) then return false end
  end
  return true
end

function Util.encodeJson(value)
  local kind = type(value)
  if value == nil or value == Util.null then return 'null' end
  if kind == 'boolean' then return tostring(value) end
  if kind == 'number' then
    if value ~= value or value == math.huge or value == -math.huge then error('JSON cannot hold ' .. tostring(value)) end
    if value == floor(value) and math.abs(value) < 2 ^ 53 then return string.format('%d', value) end
    return string.format('%.17g', value)
  end
  if kind == 'string' then return encodeString(value) end
  if kind ~= 'table' then error('JSON cannot hold a ' .. kind) end
  local parts = {}
  if isArray(value) then
    for i = 1, #value do parts[i] = Util.encodeJson(value[i]) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys = {}
  for k in pairs(value) do
    if type(k) ~= 'string' then error('JSON object keys must be strings') end
    keys[#keys + 1] = k
  end
  table.sort(keys)
  for i, k in ipairs(keys) do parts[i] = encodeString(k) .. ':' .. Util.encodeJson(value[k]) end
  return '{' .. table.concat(parts, ',') .. '}'
end

local function utf8char(code)
  if code < 0x80 then return string.char(code) end
  if code < 0x800 then return string.char(0xC0 + floor(code / 0x40), 0x80 + code % 0x40) end
  if code < 0x10000 then
    return string.char(0xE0 + floor(code / 0x1000), 0x80 + floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
  end
  return string.char(0xF0 + floor(code / 0x40000), 0x80 + floor(code / 0x1000) % 0x40,
    0x80 + floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
end

function Util.decodeJson(text)
  if type(text) ~= 'string' then error('JSON text expected') end
  local pos = 1
  local function fail(msg) error(string.format('Bad JSON at %d: %s', pos, msg), 0) end
  local function skip() pos = text:find('[^ \t\r\n]', pos) or #text + 1 end
  local value

  local function str()
    pos = pos + 1
    local out = {}
    while true do
      local c = text:sub(pos, pos)
      if c == '' then fail('unterminated string') end
      if c == '"' then pos = pos + 1; return table.concat(out) end
      if c == '\\' then
        local e = text:sub(pos + 1, pos + 1)
        local simple = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }
        if simple[e] then
          out[#out + 1] = simple[e]; pos = pos + 2
        elseif e == 'u' then
          local code = tonumber(text:sub(pos + 2, pos + 5), 16) or fail('bad \\u escape')
          pos = pos + 6
          if code >= 0xD800 and code <= 0xDBFF and text:sub(pos, pos + 1) == '\\u' then
            local low = tonumber(text:sub(pos + 2, pos + 5), 16)
            if low and low >= 0xDC00 and low <= 0xDFFF then
              code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
              pos = pos + 6
            end
          end
          out[#out + 1] = utf8char(code)
        else
          fail('bad escape')
        end
      else
        local stop = text:find('["\\]', pos) or #text + 1
        out[#out + 1] = text:sub(pos, stop - 1)
        pos = stop
      end
    end
  end

  function value()
    skip()
    local c = text:sub(pos, pos)
    if c == '{' then
      pos = pos + 1
      local obj = {}
      skip()
      if text:sub(pos, pos) == '}' then pos = pos + 1; return obj end
      while true do
        skip()
        if text:sub(pos, pos) ~= '"' then fail('key expected') end
        local k = str()
        skip()
        if text:sub(pos, pos) ~= ':' then fail('colon expected') end
        pos = pos + 1
        local v = value()
        if v ~= Util.null then obj[k] = v end
        skip()
        local d = text:sub(pos, pos)
        pos = pos + 1
        if d == '}' then return obj end
        if d ~= ',' then fail('comma expected') end
      end
    elseif c == '[' then
      pos = pos + 1
      local arr = {}
      skip()
      if text:sub(pos, pos) == ']' then pos = pos + 1; return arr end
      while true do
        local v = value()
        arr[#arr + 1] = v ~= Util.null and v or nil
        skip()
        local d = text:sub(pos, pos)
        pos = pos + 1
        if d == ']' then return arr end
        if d ~= ',' then fail('comma expected') end
      end
    elseif c == '"' then
      return str()
    elseif text:sub(pos, pos + 3) == 'true' then pos = pos + 4; return true
    elseif text:sub(pos, pos + 4) == 'false' then pos = pos + 5; return false
    elseif text:sub(pos, pos + 3) == 'null' then pos = pos + 4; return Util.null
    end
    local num = text:match('^-?%d+%.?%d*[eE]?[-+]?%d*', pos)
    if not num or num == '' or num == '-' then fail('value expected') end
    pos = pos + #num
    return tonumber(num) or fail('bad number')
  end

  local result = value()
  skip()
  if pos <= #text then fail('trailing text') end
  if result == Util.null then return nil end
  return result
end

---------------------------------------------------------------------------
-- SHA-256 for short strings (PKCE). Files are hashed by the OS; see Connect.
-- ponytail: arithmetic bit ops are slow (~ms per block), fine for a 64-byte verifier.
---------------------------------------------------------------------------

local MOD = 2 ^ 32

local function bitop(a, b, fn)
  local r, bitv = 0, 1
  for _ = 1, 32 do
    local x, y = a % 2, b % 2
    if fn(x, y) then r = r + bitv end
    a, b, bitv = floor(a / 2), floor(b / 2), bitv * 2
  end
  return r
end
local function band(a, b) return bitop(a, b, function(x, y) return x == 1 and y == 1 end) end
local function bxor(a, b) return bitop(a, b, function(x, y) return x ~= y end) end
local function bnot(a) return MOD - 1 - a end
local function rrot(a, n) local p = 2 ^ n; return floor(a / p) + (a % p) * (MOD / p) end
local function rshift(a, n) return floor(a / 2 ^ n) end

local K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

function Util.sha256Hex(msg)
  local len = #msg
  msg = msg .. '\128' .. string.rep('\0', (55 - len) % 64)
  local bits = len * 8
  local tail = {}
  for i = 8, 1, -1 do tail[i] = string.char(bits % 256); bits = floor(bits / 256) end
  msg = msg .. table.concat(tail)

  local h = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 }
  for chunk = 1, #msg, 64 do
    local w = {}
    for i = 0, 15 do
      local a, b, c, d = msg:byte(chunk + i * 4, chunk + i * 4 + 3)
      w[i] = ((a * 256 + b) * 256 + c) * 256 + d
    end
    for i = 16, 63 do
      local s0 = bxor(bxor(rrot(w[i - 15], 7), rrot(w[i - 15], 18)), rshift(w[i - 15], 3))
      local s1 = bxor(bxor(rrot(w[i - 2], 17), rrot(w[i - 2], 19)), rshift(w[i - 2], 10))
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) % MOD
    end
    local a, b, c, d, e, f, g, hh = h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]
    for i = 0, 63 do
      local S1 = bxor(bxor(rrot(e, 6), rrot(e, 11)), rrot(e, 25))
      local ch = bxor(band(e, f), band(bnot(e), g))
      local t1 = (hh + S1 + ch + K[i + 1] + w[i]) % MOD
      local S0 = bxor(bxor(rrot(a, 2), rrot(a, 13)), rrot(a, 22))
      local maj = bxor(bxor(band(a, b), band(a, c)), band(b, c))
      local t2 = (S0 + maj) % MOD
      hh, g, f, e, d, c, b, a = g, f, e, (d + t1) % MOD, c, b, a, (t1 + t2) % MOD
    end
    local add = { a, b, c, d, e, f, g, hh }
    for i = 1, 8 do h[i] = (h[i] + add[i]) % MOD end
  end
  local out = {}
  for i = 1, 8 do out[i] = string.format('%08x', h[i]) end
  return table.concat(out)
end

---------------------------------------------------------------------------
-- Encoding helpers
---------------------------------------------------------------------------

local B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

-- base64url without padding, from a hex string
function Util.base64urlFromHex(hex)
  local bytes = {}
  for i = 1, #hex, 2 do bytes[#bytes + 1] = tonumber(hex:sub(i, i + 1), 16) end
  local out = {}
  for i = 1, #bytes, 3 do
    local a, b, c = bytes[i], bytes[i + 1], bytes[i + 2]
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    local chars = 2 + (b and 1 or 0) + (c and 1 or 0)
    for j = 1, chars do
      local idx = floor(n / 2 ^ (6 * (4 - j))) % 64
      out[#out + 1] = B64:sub(idx + 1, idx + 1)
    end
  end
  return table.concat(out)
end

function Util.pkceChallenge(verifier)
  return Util.base64urlFromHex(Util.sha256Hex(verifier))
end

function Util.urlEncode(s)
  return (tostring(s):gsub('[^%w%-%._~]', function(c) return string.format('%%%02X', c:byte()) end))
end

function Util.formEncode(fields)
  local keys = {}
  for k in pairs(fields) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for i, k in ipairs(keys) do parts[i] = Util.urlEncode(k) .. '=' .. Util.urlEncode(fields[k]) end
  return table.concat(parts, '&')
end

function Util.parseQuery(url)
  local out = {}
  local query = url:match('%?([^#]*)')
  if not query then return out end
  for pair in query:gmatch('[^&]+') do
    local k, v = pair:match('^([^=]*)=?(.*)$')
    local function dec(s) return (s:gsub('+', ' '):gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end)) end
    out[dec(k)] = dec(v)
  end
  return out
end

-- "https://Photos.Example.com:2283/" -> "https://photos.example.com:2283"; nil if not http(s)
function Util.normalizeLibraryUrl(input)
  if type(input) ~= 'string' then return nil end
  local s = input:match('^%s*(.-)%s*$')
  if s == '' then return nil end
  if not s:find('://', 1, true) then s = 'https://' .. s end
  local scheme, host, rest = s:match('^(%a[%w+.-]*)://([^/?#]+)(.*)$')
  if not scheme then return nil end
  scheme = scheme:lower()
  if scheme ~= 'http' and scheme ~= 'https' then return nil end
  if host:find('@', 1, true) then return nil end
  local path = (rest:match('^([^?#]*)') or ''):gsub('/+$', '')
  return scheme .. '://' .. host:lower() .. path
end

---------------------------------------------------------------------------
-- Publish mapping
---------------------------------------------------------------------------

-- Same rendered bytes -> same request ID, so a retried export reuses the server receipt.
-- An edited photo renders new bytes and becomes a new copy; earlier copies stay.
function Util.requestId(localIdentifier, sha256)
  return 'lr-' .. tostring(localIdentifier) .. '-' .. sha256
end

function Util.albumRequestId(collectionLocalIdentifier)
  return 'lr-collection-' .. tostring(collectionLocalIdentifier)
end

-- First 64 hex characters in shasum/certutil output.
function Util.parseDigest(output)
  if type(output) ~= 'string' then return nil end
  for line in output:gmatch('[^\r\n]+') do
    local compact = line:gsub('%s', ''):lower()
    local hex = compact:match('^(%x+)')
    if hex and #hex >= 64 then return hex:sub(1, 64) end
  end
  return nil
end

-- Lightroom's "keywordTagsForExport" is comma separated. Connect accepts 1-20 tags.
function Util.keywordTags(formatted, limit)
  local tags, seen = {}, {}
  if type(formatted) ~= 'string' then return tags end
  for raw in formatted:gmatch('[^,]+') do
    local tag = raw:match('^%s*(.-)%s*$')
    local key = tag:lower()
    if tag ~= '' and #tag <= 255 and not seen[key] then
      seen[key] = true
      tags[#tags + 1] = tag
      if #tags == (limit or 20) then break end
    end
  end
  return tags
end

-- Seconds since the epoch (UTC) -> RFC 3339 with a Z offset.
function Util.isoUtc(epochSeconds)
  return os.date('!%Y-%m-%dT%H:%M:%SZ', floor(epochSeconds))
end

-- Lightroom dates count seconds from 2001-01-01 UTC.
Util.COCOA_EPOCH_OFFSET = 978307200

function Util.isoFromCocoa(cocoaSeconds)
  return Util.isoUtc(cocoaSeconds + Util.COCOA_EPOCH_OFFSET)
end

-- Rendered file name for the upload: keep the stem, force a .jpg extension, drop path separators/control chars.
function Util.uploadFilename(path)
  local leaf = tostring(path):match('([^/\\]+)$') or 'photo.jpg'
  local stem = leaf:gsub('%.[^.]*$', ''):gsub('[%c/\\]', '')
  if stem == '' then stem = 'photo' end
  return stem:sub(1, 240) .. '.jpg'
end

return Util
