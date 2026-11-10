/**
 * FL-1359: reads one font's facts in a process of its own and prints them as JSON. A font is a file a
 * stranger wrote: parsed here, the worst it can do is use up this short-lived process's memory or time
 * (MediaRepository.readFontFacts sets both limits), and the font then keeps its name only.
 */
import { readFileSync } from 'node:fs';
import { readFontFacts } from 'src/utils/font-file.js';

const [path, filename] = process.argv.slice(2);
process.stdout.write(JSON.stringify(readFontFacts(readFileSync(path), filename)));
