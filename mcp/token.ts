import { randomBytes } from 'node:crypto'

// A separate CLI, never imported by the MCP stdio server.
process.stdout.write(`${randomBytes(32).toString('base64url')}\n`)
