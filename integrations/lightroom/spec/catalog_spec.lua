-- Every LOC key used by the plugin must exist in every language file with the same placeholders.
local LANGS = { 'da', 'de', 'es', 'fr', 'it', 'nb', 'nl', 'pl', 'pt', 'sv' }
local DIR = 'frameleaf.lrplugin/'

local function read(path)
  local f = assert(io.open(path, 'rb'))
  local text = f:read('*a')
  f:close()
  return text
end

local function placeholders(s)
  local out = {}
  for p in s:gmatch('%^%d') do out[#out + 1] = p end
  table.sort(out)
  return table.concat(out, ',')
end

local used = {}
for _, file in ipairs({ 'Info.lua', 'Connect.lua', 'PublishServiceProvider.lua', 'URLHandler.lua' }) do
  for key, english in read(DIR .. file):gmatch('%$%$%$/Frameleaf/([%w/]+)=([^\'"]*)') do
    assert(used[key] == nil or used[key] == english, 'two English texts for ' .. key)
    used[key] = english
  end
end

local function catalog(lang)
  local entries = {}
  for line in read(DIR .. 'TranslatedStrings_' .. lang .. '.txt'):gmatch('[^\n]+') do
    local key, text = line:match('^"%$%$%$/Frameleaf/([%w/]+)=(.*)"%s*$')
    assert(key, lang .. ': bad line ' .. line)
    assert(entries[key] == nil, lang .. ': duplicate ' .. key)
    assert(not text:find('"', 1, true), lang .. ': raw quote in ' .. key)
    entries[key] = text
  end
  return entries
end

describe('translations', function()
  it('English catalogue matches the source', function()
    local en = catalog('en')
    for key, english in pairs(used) do assert.are.equal(english, en[key], key) end
    for key in pairs(en) do assert.is_not_nil(used[key], 'unused ' .. key) end
  end)

  for _, lang in ipairs(LANGS) do
    it(lang .. ' has every key with matching placeholders', function()
      local entries = catalog(lang)
      for key, english in pairs(used) do
        assert.is_not_nil(entries[key], lang .. ' missing ' .. key)
        assert.are_not.equal('', entries[key], lang .. ' empty ' .. key)
        assert.are.equal(placeholders(english), placeholders(entries[key]), lang .. ' placeholders ' .. key)
      end
      for key in pairs(entries) do assert.is_not_nil(used[key], lang .. ' unused ' .. key) end
    end)
  end
end)
