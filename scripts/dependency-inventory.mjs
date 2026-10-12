import fs from 'node:fs'
import path from 'node:path'

// A reproducible inventory of installed production packages, not a legal clearance.
const root = path.resolve(import.meta.dirname, '..')
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
const packages = []
for (const [relative, locked] of Object.entries(lock.packages || {})) {
  if (!relative || locked.dev) continue
  const directory = path.join(root, relative)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  const licenseFiles = fs.readdirSync(directory).filter((name) => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name))
    .filter((name) => fs.statSync(path.join(directory, name)).isFile()).map((name) => `${relative}/${name}`)
  packages.push({ name: manifest.name, version: manifest.version, license: manifest.license || locked.license || 'UNSPECIFIED',
    packagePath: relative, licenseFiles, repository: manifest.repository || null })
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const output = path.resolve(process.argv[2] || path.join(root, '.tmp', 'dependency-inventory.json'))
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), productVersion: lock.version,
  scope: 'Installed production dependencies on this platform. Excludes app artwork, fonts outside npm, remote services, and external CLIs.',
  packages }, null, 2) + '\n', 'utf8')
console.log(`${packages.length} installed production packages inventoried: ${output}`)
