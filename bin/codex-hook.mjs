#!/usr/bin/env node
import * as adapter from '../adapters/codex.mjs';
import { main } from '../src/entry.mjs';

await main(adapter);
