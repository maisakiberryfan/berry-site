#!/usr/bin/env node
// IP → ISO country code lookup via DB-IP Lite mmdb.
// Reads IPs from stdin (one per line), outputs "IP\tCountryCode" to stdout.
// Country code "??" means lookup failed (private IP, malformed, or not in DB).
//
// Usage: node lookup-country.mjs <path-to-mmdb> < ips.txt > ip_country.tsv

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Reader } from 'mmdb-lib'

const mmdbPath = process.argv[2]
if (!mmdbPath) {
  console.error('Usage: node lookup-country.mjs <path-to-mmdb>')
  process.exit(1)
}

const buffer = readFileSync(mmdbPath)
const reader = new Reader(buffer)

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of rl) {
  const ip = line.trim()
  if (!ip) continue
  let code = '??'
  try {
    const result = reader.get(ip)
    code = result?.country?.iso_code || '??'
  } catch { /* malformed IP */ }
  console.log(`${ip}\t${code}`)
}
