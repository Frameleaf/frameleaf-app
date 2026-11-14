// node render.cjs <locale>         prints a private-copy entry point for that language
// node render.cjs <locale> --help  prints that language's setup help (help/<locale>.md)
const locale = process.argv[2];
const locales = require("./locales.json");
if (!Object.hasOwn(locales, locale)) throw new Error("Unsupported locale");
const text = locales[locale];
process.stdout.write(
  process.argv[3] === "--help"
    ? `# ${text.heading}\n\n` +
        ["status", "permissions", "hosting", "setup", "polling", "sourceIds", "files", "qualification"]
          .map((key) => text[key])
          .join("\n\n") +
        "\n"
    : `module.exports = require('./app')(${JSON.stringify(locale)});\n`,
);
