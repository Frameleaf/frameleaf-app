local LrDialogs = import 'LrDialogs'
local LrTasks = import 'LrTasks'

local Connect = require 'Connect'

return {
  URLHandler = function(url)
    if not tostring(url):lower():find('^lightroom://net%.frameleaf%.connect/oauth/callback') then return end
    LrTasks.startAsyncTask(function()
      local ok, message = Connect.finishSignIn(url)
      if ok then
        LrDialogs.message(LOC '$$$/Frameleaf/Connected=Lightroom is connected to Frameleaf.')
      else
        LrDialogs.message(LOC '$$$/Frameleaf/Title=Frameleaf', message, 'critical')
      end
    end)
  end,
}
