import { spawnSync } from 'node:child_process'

for (const file of ['assistant-store-test.mjs', 'assistant-renderer-test.mjs', 'assistant-workflow-test.mjs', 'assistant-runtime-test.mjs']) {
  const result = spawnSync(process.execPath, [`scripts/${file}`], { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    break
  }
}
