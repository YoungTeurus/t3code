# Local Codex plugin picker build

This fork keeps the Codex plugin picker on the `codex-plugin-picker` branch,
based on a published Beta release. The fork's `main` branch stays available
for upstream history.

## Build

Follow [development setup](development.md#first-checkout), then run:

```sh
vp env on node
vp i
vp run check:changed v0.1.5
T3CODE_DESKTOP_VERSION=0.1.5-preview.20261030.1 vp run dist:desktop:dmg --arch arm64
```

Use a new preview version for each build. The existing preview packaging path
omits the update feed, which disables automatic official updates. Keep the
`T3 Code (Beta)` product name and app ID when replacing the Beta app so its
existing data location stays the same. Local artifacts are unsigned.

Inspect the packaged version and confirm that `Contents/Resources/app-update.yml`
is absent before replacing the installed app. Keep the previous app bundle
for rollback. Quit T3 Code before swapping app bundles; replacing files while
its server is running can mix old and new resources.

## Update to a published Beta

With a clean working tree, replace the two release placeholders:

```sh
git fetch upstream --tags
git switch codex-plugin-picker
git rebase --onto <new-beta-tag> <previous-beta-tag>
vp i
vp run check:changed <new-beta-tag>
```

Resolve conflicts and rebuild using the new Beta version plus a preview suffix.
After checking the new build, publish the rebased branch with
`git push --force-with-lease origin codex-plugin-picker`. This updates only the
fork's patch branch. Keep upstream release tags unchanged.
