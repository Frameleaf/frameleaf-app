import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

export async function render(locale, component) {
  const messages = await read('locales.json');
  if (!Object.hasOwn(messages, locale)) throw new Error('Unsupported locale');
  if (!['parameters', 'communication', 'scope', 'help'].includes(component)) {
    throw new Error('Unsupported component');
  }
  const text = messages[locale];
  if (component === 'help') return text.help;
  const value = await read(`connection/${component}.json`);
  if (component === 'parameters') {
    [value[0].label, value[0].help, value[1].label, value[1].help] = [
      text.serverLabel, text.serverHelp, text.clientLabel, text.clientHelp,
    ];
  }
  if (component === 'communication') {
    for (const key of ['token', 'refresh', 'info', 'invalidate']) {
      value[key].response.error.message = text.error;
    }
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const value = await render(process.argv[2] ?? 'en', process.argv[3] ?? 'parameters');
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  } catch {
    process.stderr.write('Choose a supported locale and component: parameters, communication, scope, help.\n');
    process.exitCode = 1;
  }
}
