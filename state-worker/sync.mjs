#!/usr/bin/env node
import { runSync } from './src/sync.mjs';

const code = await runSync(process.argv.slice(2));
process.exit(code);
