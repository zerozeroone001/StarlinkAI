import fs from 'node:fs'
import path from 'node:path'
import type { PetGeneratedMedia } from '../shared/types'
import type { PetMediaJobOptions } from './pet-media-job'
import { inspectPetAlpha, writeColorSafeCutout } from './pet-cutout'
import { portraitCutoutPrompt } from './pet-prompts'
import { writePetArtifact } from './pet-action-sheet'

type Runner = (dir: string, prompt: string, options: PetMediaJobOptions) => Promise<void>

/** One generation phase only. Native alpha is preserved; opaque key backgrounds are handled locally. */
export async function runPetPortraitGeneration(dir: string, description: string, count: number, run: Runner): Promise<PetGeneratedMedia[]> {
  if (![1, 2, 4].includes(count)) throw new Error('PET_IMAGE_COUNT_INVALID')
  const results: PetGeneratedMedia[] = []
  const accepted = new Set<string>()
  let failure: unknown
  try {
    await run(dir, portraitCutoutPrompt(description, count), {
      maxTurns: count + 6, disableWebSearch: true, imageTools: ['image_gen'],
      rules: 'Generate the requested isolated transparent character assets directly. Never create a scene first or start a second background-removal/editing phase. Do not inspect or copy output files; the app validates and saves each returned image.',
      acceptImage(file) {
        const source = fs.realpathSync(file)
        if (accepted.has(source)) return results.length === count
        if (results.length >= count) return true
        const raw = inspectPetAlpha(source)
        const destination = path.join(dir, `pet-${results.length + 1}.png`)
        if (!writeColorSafeCutout(source, destination)) throw new Error('PET_SUBJECT_INVALID: provider did not return alpha or a removable key background; no second AI extraction was attempted')
        if (!inspectPetAlpha(destination).nativeAlpha) throw new Error('PET_SUBJECT_INVALID: no useful transparent pixels')
        accepted.add(source)
        results.push({ path: destination, dataUrl: `data:image/png;base64,${fs.readFileSync(destination).toString('base64')}`, mime: 'image/png', transparency: raw.nativeAlpha ? 'native-alpha' : 'local-key' })
        writePetArtifact(path.join(dir, 'generation-info.json'), JSON.stringify({ mode: 'direct-cutout', requestedCount: count,
          results: results.map(item => ({ file: path.basename(item.path), transparency: item.transparency })) }, null, 2))
        return results.length === count
      }
    })
  } catch (error) { failure = error }
  if (results.length !== count) throw failure || new Error('PET_SUBJECT_MISSING: the provider did not return all requested transparent targets')
  return results
}
