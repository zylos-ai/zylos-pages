#!/usr/bin/env node

// Compatibility wrapper. The agent-facing local DB CLI now lives in pages.js.
import { run } from './pages.js';

run(process.argv.slice(2));
