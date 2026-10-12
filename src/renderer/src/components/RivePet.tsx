import { useEffect, useMemo, useRef } from 'react'
import { RuntimeLoader, StateMachineInputType, useRive } from '@rive-app/react-webgl2'
import riveWasmUrl from '@rive-app/webgl2/rive.wasm?url'
import riveFallbackWasmUrl from '@rive-app/webgl2/rive_fallback.wasm?url'
import type { PetMood, PetMotion, PetRiveConfig } from '@shared/types'

RuntimeLoader.setWasmUrl(riveWasmUrl)
RuntimeLoader.setWasmFallbackUrl(riveFallbackWasmUrl)

const MOOD_VALUE: Record<PetMood, number> = {
  idle: 0,
  running: 1,
  waiting: 2,
  review: 3,
  failed: 4,
  waving: 5,
  jumping: 6
}

const MOTION_VALUE: Record<PetMotion, number> = {
  idle: 0,
  wave: 1,
  jump: 2,
  dance: 3,
  sleep: 4,
  spin: 5,
  cheer: 6,
  run: 7,
  sit: 8,
  shy: 9
}

function moodMotion(mood: PetMood): PetMotion {
  if (mood === 'waving') return 'wave'
  if (mood === 'jumping') return 'jump'
  if (mood === 'running') return 'run'
  if (mood === 'waiting') return 'sit'
  if (mood === 'failed') return 'shy'
  if (mood === 'review') return 'cheer'
  return 'idle'
}

function dataUrlBuffer(source: string): ArrayBuffer | null {
  const match = /^data:[^;,]+;base64,(.+)$/i.exec(source)
  if (!match) return null
  try {
    const binary = window.atob(match[1])
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes.buffer
  } catch {
    return null
  }
}

export function RivePet({
  src,
  config,
  mood,
  motion,
  onError
}: {
  src: string
  config: PetRiveConfig
  mood: PetMood
  motion?: PetMotion
  onError: () => void
}) {
  const errorRef = useRef(onError)
  errorRef.current = onError
  const buffer = useMemo(() => dataUrlBuffer(src), [src])
  const params = useMemo(
    () =>
      buffer
        ? {
            buffer,
            artboard: config.artboard,
            stateMachines: config.stateMachine,
            autoplay: true,
            automaticallyHandleEvents: false,
            onLoadError: () => errorRef.current()
          }
        : null,
    [buffer, config.artboard, config.stateMachine]
  )
  const { rive, RiveComponent } = useRive(params, {
    shouldResizeCanvasToContainer: true,
    useOffscreenRenderer: true
  })

  useEffect(() => {
    if (!buffer) errorRef.current()
  }, [buffer])

  useEffect(() => {
    if (!rive) return
    if (!rive.stateMachineNames.includes(config.stateMachine)) {
      errorRef.current()
      return
    }
    const activeMotion = motion || moodMotion(mood)
    const inputs = rive.stateMachineInputs(config.stateMachine)
    for (const input of inputs) {
      if (input.type === StateMachineInputType.Number && input.name === config.moodInput) {
        input.value = MOOD_VALUE[mood]
      } else if (input.type === StateMachineInputType.Number && input.name === config.motionInput) {
        input.value = MOTION_VALUE[activeMotion]
      } else if (input.type === StateMachineInputType.Boolean && input.name in MOOD_VALUE) {
        input.value = input.name === mood
      } else if (input.type === StateMachineInputType.Boolean && input.name in MOTION_VALUE) {
        input.value = input.name === activeMotion
      }
    }
    if (motion) {
      const triggerName = config.triggers?.[motion] || motion
      const trigger = inputs.find(
        (input) => input.type === StateMachineInputType.Trigger && input.name === triggerName
      )
      trigger?.fire()
    }
  }, [config, mood, motion, rive])

  return <RiveComponent className="pet-rive" aria-hidden="true" />
}
