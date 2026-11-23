# film-set-e2e

TapNow Film set node checks run on Sway's Mac (real GPU, Chrome and WebKit) through a GitHub self-hosted runner.
The runner only connects out to GitHub; it runs the workflow in this private repo and nothing else. Stop it with Ctrl+C.

- `popup`: open a finished set's popup — time to picture, light viewer, canvas frames while open, card videos pausing, shot button.
- `build`: build a new set, open its popup while it builds, then check the turntable video (1280×720, ~30 s, size).

Results: the run's artifact (result.json, log.txt, screenshots, a screen recording).
