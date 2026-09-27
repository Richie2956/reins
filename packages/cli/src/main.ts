#!/usr/bin/env node
// quiet.js first, then the CLI through a dynamic import: builtins such as
// node:sqlite load while a static import graph links, before any code runs,
// so the warning filter has to be in place before cli.js is even requested.
import './quiet.js';

const { run } = await import('./cli.js');

// exitCode rather than exit(): proxy and dashboard keep a server listening,
// and node leaves on its own once the event loop drains for everything else.
process.exitCode = await run(process.argv.slice(2));
