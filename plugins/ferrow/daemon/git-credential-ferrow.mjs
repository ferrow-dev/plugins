#!/usr/bin/env node
import { helper } from './lib/credential.mjs'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const out = await helper({ op: process.argv[2], input })
if (out.stderr) process.stderr.write(out.stderr)
if (out.stdout) process.stdout.write(out.stdout)
process.exitCode = out.code
