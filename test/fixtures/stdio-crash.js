#!/usr/bin/env node
// Fixture: the process exits immediately with a non-zero code. From the
// client's point of view it is indistinguishable from a misconfigured command.

console.error('Error: DATABASE_URL is not set');
process.exit(1);
