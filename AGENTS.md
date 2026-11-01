# Repository instructions

## Release delivery

When the user requests a release (发布/升级版本/打 tag/替换本机), complete the authorized delivery end to end rather than asking them to enumerate each step:

1. Isolate the requested changes from unrelated work. Use a branch and a PR into `main`.
2. Choose the version by compatibility impact: patch for compatible fixes, minor for added features/sources, major for breaking contracts. Declare the stable baseline, change type and reason in `.github/release-plan.json`. Feature/breaking releases must publish and verify an RC before stable promotion. Update root/workspace versions, lockfile, `CHANGELOG.md`, release notes and `.github/release-request` together.
3. Push, create the PR, inspect all CI checks and resolve failures before merging. Do not bypass checks. A request only to commit/push does not authorize publishing or installing.
4. Merge the release PR only when release delivery is authorized. The Release Kickoff workflow creates the tag at the merged commit and dispatches Release. Do not create a competing local tag.
5. Require all platform artifacts and updater metadata to pass checksum verification before exposing the Release; do not overwrite published assets. Verify the tag target, CI results, and published assets. Report actual failures rather than claiming a release succeeded from a push alone.
6. If local replacement is requested, install the matching GitHub Release artifact, verify its published checksum, preserve configuration and database backups, announce any gateway interruption, and verify the installed version, configuration and live service after restarting. Existing explicit authorization covers the replacement; do not ask again for the same action.

See [docs/releasing.md](docs/releasing.md) for the commands and recovery procedure.

## Product copy

User-visible interfaces and exports contain product content, not agent plans, implementation explanations or debugging notes. Keep that information in chat, code comments and development documentation.

## Renderer UI consistency

For any change under `packages/ui/src`, follow [UI-STYLE-GUIDE.md](UI-STYLE-GUIDE.md) §0:

- Theme values come only from `packages/ui/src/styles/tokens.css` (Tailwind's default theme is cleared). Use semantic tokens such as `bg-background`, `text-muted-foreground`, `border-border`, `text-brand-ink`, `bg-status-ok`, `text-body`, `max-w-page` and `duration-fast`; add a token there, for light and dark, when none fits.
- Page code takes controls from `@/components/ui/*` and icons from `@/components/ui/icons`. Do not import Radix, Base UI or `lucide-react` directly, or write native `<button>`/`<select>`; extend the shared component instead.
- `npm run check:ui` must pass. It forbids raw colours, Tailwind arbitrary values, raw palette colours, primitive imports and native controls in page code, against `build/check-ui-baseline.json`, which may only go down. Never raise the baseline; after removing violations run `npm run check:ui -- --update-baseline` and commit the lowered file. Rule changes need matching fixtures in `tests/ui-guard` (`npm run test:ui-guard`).
- Enable the pre-commit hook once per clone with `npm run hooks:install`. Attach light, dark and narrow before/after screenshots to UI changes.
