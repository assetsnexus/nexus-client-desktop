#!/usr/bin/env node
// Thin launcher for the compiled CLI.
import('../dist/index.js').then((m) => m.main()).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
