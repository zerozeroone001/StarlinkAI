// Permission waiting is a separate phase and does not spend the employee's execution budget.
export function executionClock(executionMs: number, permissionMs: number, expire: (message: string) => void,
  now: () => number = () => performance.now()) {
  let executionElapsed = 0, permissionElapsed = 0, started = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let permissionTimer: ReturnType<typeof setTimeout> | undefined
  let waiting = false, closed = false
  const elapsed = () => {
    const current = closed ? 0 : Math.max(0, now() - started)
    return { executionMs: executionElapsed + (waiting ? 0 : current),
      permissionMs: permissionElapsed + (waiting ? current : 0) }
  }
  const resume = () => {
    if (closed) return
    clearTimeout(permissionTimer)
    permissionTimer = undefined
    if (waiting) permissionElapsed += Math.max(0, now() - started)
    waiting = false
    started = now()
    timer = setTimeout(() => expire('当前员工执行超时，已有结果已保留。'), Math.max(1, executionMs - executionElapsed))
  }
  resume()
  return {
    pause() {
      if (waiting || closed) return
      executionElapsed += Math.max(0, now() - started)
      clearTimeout(timer)
      waiting = true
      started = now()
      permissionTimer = setTimeout(() => expire('等待操作确认超时，已有结果已保留。'), permissionMs)
    },
    resume() { if (waiting) resume() },
    elapsed,
    close() {
      if (closed) return
      const totals = elapsed()
      executionElapsed = totals.executionMs
      permissionElapsed = totals.permissionMs
      closed = true
      clearTimeout(timer)
      clearTimeout(permissionTimer)
    }
  }
}
