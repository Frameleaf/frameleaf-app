module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication: require('./authentication')('en'),
  triggers: {},
  searches: {},
  creates: {},
};
