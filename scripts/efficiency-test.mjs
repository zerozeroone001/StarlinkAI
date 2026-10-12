import { spawnSync } from 'node:child_process'

for (const file of ['coordination-efficiency-test.mjs', 'runtime-efficiency-test.mjs', 'worker-context-test.mjs', 'execution-quality-test.mjs']) {
  const result = spawnSync(process.execPath, [`scripts/${file}`], { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
}
