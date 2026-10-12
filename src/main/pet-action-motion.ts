import fs from 'node:fs'
import { nativeImage } from 'electron'
import type { PetAtlas } from '../shared/types'

export const ACTION_MOTION_VERSION = 'cycle-v4-direct-alpha'

export function isWalkingAction(description: string): boolean {
  if (/(?:不要|禁止|避免|不能).{0,6}(?:走|步行)|\b(?:no|without|don['’]t)\s+walk/i.test(description)) return false
  return /走动|走路|行走|步行|散步|慢走|\bwalk(?:ing)?\b/i.test(description)
}

const WALK_BEATS = [
  'LEFT CONTACT: left heel lands clearly ahead of the hips, right leg extends behind on its toes; right arm forward and left arm back',
  'LEFT DOWN: weight settles onto the bent left support knee; right foot pushes off and lifts; right arm is still forward',
  'RIGHT PASSING: left foot supports beneath the hips, right knee bends and swings forward past it with the right shoe CLEARLY OFF the ground; arms pass beside the torso',
  'LEFT UP: body rises over the left forefoot, right leg reaches forward through the air; left arm swings forward and right arm back',
  'RIGHT CONTACT: right heel lands clearly ahead of the hips, left leg extends behind on its toes; left arm forward and right arm back; reverse the leg roles from LEFT CONTACT, do not mirror the camera',
  'RIGHT DOWN: weight settles onto the bent right support knee; left foot pushes off and lifts; left arm is still forward',
  'LEFT PASSING: right foot supports beneath the hips, left knee bends and swings forward past it with the left shoe CLEARLY OFF the ground; arms pass beside the torso',
  'RIGHT UP: body rises over the right forefoot, left leg reaches forward through the air; right arm swings forward and left arm back, returning to LEFT CONTACT'
]

export function walkingPoseBrief(phase: number): string {
  const position = ((phase % 1 + 1) % 1) * 8
  const beat = Math.floor(position), fraction = position - beat
  return fraction < 1e-5 ? WALK_BEATS[beat] :
    `Transition ${Math.round(fraction * 100)}% from [${WALK_BEATS[beat]}] toward [${WALK_BEATS[(beat + 1) % 8]}]; move the joints along the walk, do not hold the previous pose`
}

type Point = [number, number]
// Normalized side-view joint positions for one leg from heel contact through swing.
const LEG: Array<[Point, Point, Point]> = [
  [[.59, .68], [.69, .86], [.76, .87]],
  [[.57, .67], [.62, .86], [.69, .87]],
  [[.49, .69], [.48, .86], [.55, .87]],
  [[.41, .68], [.35, .83], [.42, .87]],
  [[.39, .67], [.30, .80], [.36, .86]],
  [[.44, .65], [.35, .72], [.41, .73]],
  [[.58, .66], [.50, .78], [.57, .79]],
  [[.63, .67], [.63, .80], [.70, .81]]
]

/** A reference-only skeleton; never used as a generated action frame or a fallback animation. */
export function writeWalkPoseGuide(destination: string, phases: number[], atlas: PetAtlas): void {
  const width = atlas.columns * atlas.cellWidth, height = atlas.rows * atlas.cellHeight
  // Keep reference padding transparent too; an opaque guide encourages an opaque output.
  const bitmap = Buffer.alloc(width * height * 4)
  phases.forEach((phase, cell) => {
    const ox = cell % atlas.columns * atlas.cellWidth, oy = Math.floor(cell / atlas.columns) * atlas.cellHeight
    const dot = (point: Point, radius: number, rgb: number[]) => {
      const cx = ox + point[0] * atlas.cellWidth, cy = oy + point[1] * atlas.cellHeight
      for (let y = Math.max(oy, Math.floor(cy - radius)); y <= Math.min(oy + atlas.cellHeight - 1, Math.ceil(cy + radius)); y++) {
        for (let x = Math.max(ox, Math.floor(cx - radius)); x <= Math.min(ox + atlas.cellWidth - 1, Math.ceil(cx + radius)); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue
          const at = (y * width + x) * 4
          bitmap[at] = rgb[2]; bitmap[at + 1] = rgb[1]; bitmap[at + 2] = rgb[0]
          bitmap[at + 3] = 255
        }
      }
    }
    const line = (a: Point, b: Point, color: number[], radius = 2.4) => {
      const steps = Math.ceil(Math.hypot((b[0] - a[0]) * atlas.cellWidth, (b[1] - a[1]) * atlas.cellHeight)) * 2
      for (let i = 0; i <= steps; i++) dot([a[0] + (b[0] - a[0]) * i / Math.max(1, steps), a[1] + (b[1] - a[1]) * i / Math.max(1, steps)], radius, color)
    }
    const bob = .012 * Math.sin(phase * 4 * Math.PI)
    const twist = Math.sin(phase * Math.PI * 2)
    const hip: Point = [.49 + .009 * twist, .51 + bob], shoulder: Point = [.52 - .012 * twist, .29 + bob * .65]
    const leg = (p: number, color: number[]) => {
      const t = ((p % 1 + 1) % 1) * 8, at = Math.floor(t), f = t - at
      const joints = LEG[at].map((point, j) => point.map((v, axis) => v * (1 - f) + LEG[(at + 1) % 8][j][axis] * f) as Point)
      line(hip, joints[0], color); line(joints[0], joints[1], color); line(joints[1], joints[2], color)
      const swing = Math.cos(p * Math.PI * 2)
      const elbow: Point = [shoulder[0] - .09 * swing, .41 + bob * .65], wrist: Point = [shoulder[0] - .19 * swing, .52 + bob * .65]
      line(shoulder, elbow, color); line(elbow, wrist, color)
    }
    leg(phase + .5, [209, 135, 37])
    line(hip, shoulder, [70, 75, 84], 4)
    line(shoulder, [.53, .23 + bob * .35], [70, 75, 84], 3)
    dot([.53, .17 + bob * .35], atlas.cellWidth * .065, [100, 105, 115])
    line([.56, .16 + bob * .35], [.61, .18 + bob * .35], [100, 105, 115], 2)
    leg(phase, [44, 120, 189])
  })
  fs.writeFileSync(destination, nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG())
}
