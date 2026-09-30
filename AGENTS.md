# Repository instructions

## Release delivery

When the user requests a release (发布/升级版本/打 tag/替换本机), complete the authorized delivery end to end rather than asking them to enumerate each step:

1. Isolate the requested changes from unrelated work. Use a branch and a PR into `main`.
2. Default small bug-fix releases to a patch bump. Update root/workspace package versions, lockfile versions, `CHANGELOG.md`, `docs/releases/<version>.md`, and `.github/release-request` together.
3. Push, create the PR, inspect all CI checks and resolve failures before merging. Do not bypass checks. A request only to commit/push does not authorize publishing or installing.
4. Merge the release PR only when release delivery is authorized. The Release Kickoff workflow creates the tag at the merged commit and dispatches Release. Do not create a competing local tag.
5. Verify the tag target, CI results, and published assets. Report actual failures rather than claiming a release succeeded from a push alone.
6. If local replacement is requested, install the matching GitHub Release artifact, verify its published checksum, preserve configuration and database backups, announce any gateway interruption, and verify the installed version, configuration and live service after restarting. Existing explicit authorization covers the replacement; do not ask again for the same action.

See [docs/releasing.md](docs/releasing.md) for the commands and recovery procedure.

## Product copy

User-visible interfaces and exports contain product content, not agent plans, implementation explanations or debugging notes. Keep that information in chat, code comments and development documentation.
