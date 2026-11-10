#!/usr/bin/env node
import '../../shared/preload.mjs';
import { main } from './client.mjs';

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
