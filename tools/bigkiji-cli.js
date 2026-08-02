#!/usr/bin/env node
'use strict';

require('../src/domain/terminal/bigkiji-cli').main().catch((error) => {
  console.error(`bigkiji cli: ${error.message}`);
  process.exit(1);
});
