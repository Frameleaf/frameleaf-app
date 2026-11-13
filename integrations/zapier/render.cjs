const locale = process.argv[2];
const locales = require("./locales.json");
if (!Object.hasOwn(locales, locale)) throw new Error("Unsupported locale");
process.stdout.write(`module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication: require('./authentication')(${JSON.stringify(locale)}),
  triggers: {}, searches: {}, creates: {},
};\n`);
