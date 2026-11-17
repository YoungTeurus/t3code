# Fork maintenance and desktop builds

The fork's `main` integrates upstream with the Codex plugin picker, Arc and
Arcanum support, thread snooze dependencies, trigger waiting, and scheduled
queue limits. Update it by merging upstream so published fork commits keep
their identities.

## Update upstream

Start with a clean working tree and preserve the current `main` in a backup
branch before merging. Fetch upstream explicitly; an `upstream` remote is not
required:

```sh
git switch main
git fetch origin main
git merge --ff-only origin/main
git fetch https://github.com/pingdotgg/t3code.git main:refs/remotes/upstream/main
git merge --no-ff upstream/main
vp i
vp run check:changed upstream/main
git push origin main
```

Resolve conflicts before checking and pushing. Keep fork schema changes in
`apps/server/src/persistence/ForkMigrations/`, recorded in `fork_sql_migrations`.
Upstream owns the numeric ids in `effect_sql_migrations`. The upgrade path
recognizes the fork's previously shipped migration pairs `74/75` and `81/82`.

## Build a desktop preview

Follow [desktop artifacts](development.md#desktop-artifacts). Build from the
updated fork `main` and use a new preview version for each artifact. The preview
packaging path omits the update feed, which disables official automatic updates.
Keep the existing Beta product name and app ID when replacing the Beta app so
its data location stays the same. Local artifacts are unsigned.

Inspect the packaged version and confirm that
`Contents/Resources/app-update.yml` is absent before replacing the installed
app. Keep the previous app bundle for rollback. Quit T3 Code before swapping
app bundles; replacing files while its server is running can mix old and new
resources.
