# Floeterm Repository Guide

This file is the repository-level operating guide for `floeterm/`.

Goals:

- keep development aligned with CI and release behavior;
- never develop directly on `main`;
- preserve every intentional commit;
- keep local `main` and `origin/main` in sync whenever `main` is pushed;
- keep temporary plans and scratch notes out of the committed history.

## Git Workflow (Required)

- Never develop directly on `main`.
- Every change must be done in a dedicated worktree and feature branch.
- `main` is only for `pull --ff-only` and final integration.
- Do not leave uncommitted changes in the `main` worktree.
- If local `main` is pushed, push the full current local `main` tip together with all of its latest commits.
- Do not partial-push `main`, and do not update `origin/main` through another branch while newer local `main` commits remain unpublished.
- One feature equals one dedicated worktree plus one local private branch.
- Keep feature branches private until they are merged into `main`.
- Default sync strategy for a feature branch: `git rebase origin/main`.
- Do not merge `origin/main` into a feature branch in the normal flow.
- Preserve intentional commit history when integrating:
  - use `git merge --ff-only "$BR"` on `main` once the feature branch history is clean;
  - if the feature history is noisy, clean it inside the feature branch before integration instead of hiding it behind `--squash`.
- Resolve conflicts only inside the feature worktree, never on `main`.
- Do not merge feature branches into each other.

Recommended setup:

```bash
git fetch origin
git switch main
git pull --ff-only

BR=feat-<topic>
WT=../floeterm-feat-<topic>
git worktree add -b "$BR" "$WT" origin/main
```

## Feature Sync

Inside the feature worktree:

```bash
git status
# The worktree must be clean before rebasing.

git fetch origin
STAMP=$(date +%Y%m%d-%H%M%S)
git branch "backup/$BR-$STAMP"
git rebase origin/main
```

If conflicts happen:

```bash
git add <resolved-files>
git rebase --continue
```

If you are unsure about the resolution:

```bash
git rebase --abort
```

After every rebase:

```bash
git range-diff "backup/$BR-$STAMP"...HEAD
git diff origin/main...HEAD
make check
```

## Integration Back To Main

Once the feature branch is ready and the checks are green:

```bash
git switch main
git fetch origin
git pull --ff-only

# If local main is already ahead of origin/main, publish the full local main tip first.
# Do not keep older local main commits unpublished while only pushing the new feature result.
# git push origin main

git merge --ff-only "$BR"
git push origin main
```

Cleanup:

```bash
git worktree remove "$WT"
git branch -d "$BR"
```

If the feature branch was ever pushed:

```bash
git push origin --delete "$BR"
```

Additional rules:

- Remote `main` should always move directly to the latest local `main` tip whenever `main` is pushed.
- Do not discard, collapse, or silently rewrite meaningful feature commits during integration.
- If a feature branch has already been pushed and someone depends on it, stop treating it as a freely rewritable private branch and coordinate a conservative follow-up flow.

Recommended Git configuration:

```bash
git config --global rerere.enabled true
git config --global merge.conflictstyle zdiff3
```

## Conflict Resolution Principles

- Resolve conflicts only in the feature worktree.
- Start from the latest `origin/main` structure, then re-apply the real feature intent on top of it.
- During `git rebase origin/main`, do not use `--ours` and `--theirs` blindly:
  - `--ours` usually means the rebasing target (`origin/main`);
  - `--theirs` usually means the replayed feature commit.
- For renames, file moves, formatting updates, or import reshuffles:
  - keep the latest `main` layout first;
  - then restore the feature logic in the new location.
- For generated files, snapshots, and lockfiles:
  - prefer regeneration over manual conflict stitching.
- For delete-versus-modify conflicts:
  - verify whether `main` intentionally retired or migrated the old code before restoring anything.
- If you are not confident about the result, abort the rebase and reassess.
- After conflict resolution, review `git diff origin/main...HEAD` before continuing.

## Temporary Documents

- Temporary planning notes, checklists, scratch documents, and investigation drafts are allowed during development.
- They must not be committed.
- Prefer storing them outside the repository.
- If they must exist inside the repository during work, keep them under a path ignored by Git and make sure `git status` is clean before integration.

## Local Quality Gate

- CI is the source of truth.
- Before integration, at minimum run:

```bash
make check
```

- `make check` is expected to cover the core Go and web checks for this repository.

## Release / Tag Rules

- Floeterm releases use tags in the form `v<version>` such as `v0.4.1`.

## Repository Rule File

- `AGENTS.md` is the canonical repository rule file for this repository.
- Do not add or keep a committed repository-level `.develop.md` here.
