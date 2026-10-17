import { parseText } from './diagnostics-parsers.mjs';
let text = '';
for await (const block of process.stdin) text += block;
process.stdout.write(JSON.stringify(await parseText(process.argv[2], text)));
