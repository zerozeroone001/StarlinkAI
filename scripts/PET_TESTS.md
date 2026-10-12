# Pet action regression checks

Run `npm run test:pets`. The runner uses a temporary `GROK_HOME`, replaces all CLI
spawns, and uses Electron's real image decoder. It never requests paid media or
changes installed pets. Its temporary files are removed after the run.

For UI verification run `npx vite --config scripts/pets-preview.vite.ts`, then open
`http://127.0.0.1:5184/scripts/pets-preview.html`. This harness renders the real pet
editor and player with a synthetic waving figure; its generation and save APIs
are mocks. Check all four frame-count choices, progress before completion,
pause/resume, saved drafts, sprite-sheet/animation switching, saved metadata,
16→48 upgrades and generation after extracting the current portrait. A movement
containing `无效` deliberately fails final validation and must disable saving.
`超时` fails the first attempt with zero saved frames; resuming the same draft
completes it. The saved JSON also shows extraction options: the first extraction
allows cache reuse, while “重新提取” must send `forceRegenerate: true`.

Generated action contract:

- PNG, 16/32/48/108 row-major frames; layouts 4×4, 8×4, 8×6, 12×9.
- New images contain at most four frames (2×2). Each validated frame is saved to
  `frames/frame-NNN.png`, with an atomically replaced job manifest and immediate
  progress event. Failures retain prior pages; resume only generates missing frames.
- Each page requests one `image_edit` call. The app accepts the tool's structured
  image result directly, without waiting for agent-side copying, compositing or
  inspection. A restricted tool set excludes shells and video generation.
  Both ACP stdout and the assigned session's incremental `updates.jsonl` are
  supported, since CLI streaming JSON versions differ. Only images from that
  job/session's image folder are accepted. Long Windows paths are decoded from
  file bytes. Invalid results fail promptly and retain previous frames.
- Media jobs have an eight-minute inactivity timeout and a fifteen-minute absolute
  deadline. A validated result ends the process immediately. Cancellation keeps
  its own error code. `media-session.json` identifies the CLI session and bounded
  `media-job.log` records tool status and validation/timeout errors, without image
  payloads or reasoning. Failed drafts show whether any frames were actually saved.
- New actions first generate 16 keyframes, then use adjacent-keyframe references
  to fill missing slots. Upgrades retain all existing frames, distributing new
  slots across the loop including the seam. Original action files remain backed up.
- Default 2-second local loop; higher counts increase FPS, not duration. Upgrades
  retain the original duration. Metadata travels with the action, including
  saved manifests, action events, default-action playback and editor previews.
- Every frame must contain a subject with transparent margins. Missing, clipped,
  opaque or effectively repeated frames fail validation. These checks do not
  prove anatomical correctness or motion quality; users still preview the result.
- Legacy image/video actions remain readable; new generation only requests images.
- Subject extraction uses the `standing-v3-relaxed-arms` cache policy. Old pose
  caches are not reused, and explicit re-extraction bypasses even the current cache.
  Default people stand with relaxed arms at their sides and uncrossed, planted
  feet; clasped hands and action gestures from the source are not retained.
  Real RGBA colors are preserved;
  conservative uniform-key removal never globally suppresses the green channel.
  An explicit pose request overrides standing.

The offline suite does not prove that Grok will produce a valid sheet for a given
prompt. A live smoke test should additionally generate one real action, review
its motion, save it, play it on the desktop, and play it again after restarting.

## Optional live provider smoke test

`node scripts/pets-live-smoke.mjs --live` makes two real provider image requests
and may consume image quota. Set `PET_SMOKE_SOURCE` to a source image and
`PET_SMOKE_OUTPUT` to a new absolute directory. It generates a standing cutout
and one four-frame page, using the real runner/decoder, without modifying
installed pets or saved drafts. Set `PET_SMOKE_REUSE_SUBJECT=1` to use an already
generated cutout and request only the page. Production packages include only
`out/main`, `out/preload`, `out/renderer` and `resources`, not smoke-test images.

2026-08-28 verification: offline regression suite, both TypeScript projects,
production build, and editor timeout → resume → save flow passed. A real standing
image and a four-frame walking page were generated; the page was captured and
validated about 142 seconds after launch. A complete real 16-frame action and
desktop playback after restart were not exercised in this run.
