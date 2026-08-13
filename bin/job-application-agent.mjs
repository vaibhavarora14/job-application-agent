#!/usr/bin/env node
import { main } from '../installer/src/cli.mjs';

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
