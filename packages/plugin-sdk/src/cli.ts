import { Command } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { availableFunctions } from 'src/host-functions.js';

const program = new Command('plugin-sdk');

program
  .command('prepareBuild')
  .description('Generate .d.ts file required for extism')
  .argument('[manifest]', "Path to the plugin's manifest file", 'manifest.json')
  .option(
    '-o, --output <file>',
    'Output file for generated types',
    'dist/index.d.ts',
  )
  .action((manifest: string, { output }: { output: string }) => {
    const content = readFileSync(manifest, { encoding: 'utf-8' });
    const { methods: manifestMethods = [] } = JSON.parse(content) as {
      methods?: { name: string }[];
    };
    const methods = manifestMethods.map(({ name }) => name);
    mkdirSync(dirname(output), { recursive: true });

    writeFileSync(
      output,
      `
declare module 'extism:host' {
  interface user {
${availableFunctions.map((functionName) => `    ${functionName}(ptr: PTR): I64;`).join('\n')}
  }
}

declare module 'main' {
${methods.map((method) => `  export function ${method}(): I32;`).join('\n')}
}

export type Manifest = ${content};

      `,
    );
  });

program.parse();
