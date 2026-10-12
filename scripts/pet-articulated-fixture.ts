/** Synthetic test geometry only; never a provider fallback or a shipped pet asset. */
export function paintArticulatedFixture(bitmap: Buffer, width: number, ox: number, oy: number, cw: number, ch: number, phase: number): void {
  type Point = [number, number]
  const dot = (point: Point, radius: number, color: number[]) => {
    const cx = ox + point[0] * cw, cy = oy + point[1] * ch
    for (let y = Math.max(oy, Math.floor(cy - radius)); y <= Math.min(oy + ch - 1, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(ox, Math.floor(cx - radius)); x <= Math.min(ox + cw - 1, Math.ceil(cx + radius)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue
        color.forEach((value, i) => { bitmap[(y * width + x) * 4 + i] = value })
      }
    }
  }
  const line = (a: Point, b: Point, radius: number, color: number[]) => {
    for (let i = 0; i <= 100; i++) dot([a[0] + (b[0] - a[0]) * i / 100, a[1] + (b[1] - a[1]) * i / 100], radius, color)
  }
  const t = phase * Math.PI * 2, swing = Math.cos(t), lift = Math.sin(t)
  const body = [190, 80, 220, 255], limb = [120, 90, 160, 255]
  const hip: Point = [.49 + .025 * lift, .54 + .015 * Math.sin(t * 2)]
  const shoulder: Point = [.51 - .025 * lift, .32 + .01 * Math.sin(t * 2)]
  const head: Point = [.51, .20 + .004 * Math.sin(t * 2)]
  line(hip, shoulder, cw * .075, body); line(shoulder, head, cw * .035, body); dot(head, cw * .085, body)
  for (const side of [-1, 1]) {
    const arm = swing * side, stride = -swing * side, raised = Math.max(0, lift * side)
    const elbow: Point = [shoulder[0] + .11 * arm, .42]
    const wrist: Point = [shoulder[0] + .23 * arm, .53 - .04 * Math.abs(arm)]
    line(shoulder, elbow, cw * .028, limb); line(elbow, wrist, cw * .028, limb)
    const knee: Point = [hip[0] + .12 * stride + .04 * raised, .69 - .08 * raised]
    const ankle: Point = [hip[0] + .22 * stride, .86 - .13 * raised]
    line(hip, knee, cw * .035, body); line(knee, ankle, cw * .03, body)
    line(ankle, [ankle[0] + .06, ankle[1]], cw * .025, limb)
  }
}
