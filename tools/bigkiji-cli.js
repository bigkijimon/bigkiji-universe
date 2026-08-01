#!/usr/bin/env node
'use strict';

require('../src/domain/terminal/bigkiji-cli').main().catch((error) => {
  console.error(`BigKiji CLI: ${error.message}`);
  process.exit(1);
});
