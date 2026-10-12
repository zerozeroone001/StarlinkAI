# Rive pet contract

StarlinkAI loads Rive before portrait or sprite assets. A custom pet can import a `.riv` file
from Settings, or place `pet.riv` beside `pet.json`.

The default runtime contract is:

- State machine: `PetState`
- Number input `mood`: `idle=0`, `running=1`, `waiting=2`, `review=3`, `failed=4`,
  `waving=5`, `jumping=6`
- Number input `motion`: `idle=0`, `wave=1`, `jump=2`, `dance=3`, `sleep=4`, `spin=5`,
  `cheer=6`, `run=7`, `sit=8`, `shy=9`

The runtime also supports boolean inputs named after a mood or motion. Trigger inputs can use the
motion name, or be remapped in `pet.json`:

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "portrait": "portrait.png",
  "rive": {
    "file": "pet.riv",
    "artboard": "Pet",
    "stateMachine": "PetState",
    "moodInput": "mood",
    "motionInput": "motion",
    "triggers": {
      "wave": "WaveOnce",
      "jump": "JumpOnce"
    }
  },
  "defaultActions": {
    "work": "typing",
    "report": "present-result",
    "rest": "sleep",
    "play": "dance"
  }
}
```

All four default action slots are optional and empty by default. They refer to IDs in the pet's
`actions` array. Runtime status mapping is running → work, waiting/review/failed → report,
idle → rest, and waving/jumping → play.

Keep a transparent `portrait.png` in the same directory. It is shown automatically if the Rive
asset cannot load or does not contain the configured state machine.

For bundled pets, use matching names such as `ragdoll.riv` and `ragdoll.png` in this directory.
