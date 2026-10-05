#!/usr/bin/env node
/**
 * Legacy source-only launcher. The daemon subcommands (`server`/`client`/`agents`/`resume`/`queue`)
 * now dispatch from the native entry (`src/cli.ts` → `main.ts`), so this module just delegates.
 */
import "../cli.ts";
