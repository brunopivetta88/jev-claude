#!/usr/bin/env node
import * as adapter from '../adapters/claude-code.mjs';
import { main } from '../src/entry.mjs';

await main(adapter);
