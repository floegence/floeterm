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
- Keep feature branches local and private until they are merged into `main`.
- Do not push a feature branch or create a pull request unless the user explicitly requests that collaboration path. Do not create a pull request merely to trigger CI.
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
git rebase origin/main
```

Routine `backup/*` branches are forbidden. A stash is allowed only as a short-
term safety rope before rebasing or switching context; apply it and continue,
or drop it once confirmed obsolete. Never leave a stale stash behind.

If conflicts happen:

```bash
git add <resolved-files>
git rebase --continue
```

If you are unsure about the resolution:

```bash
git rebase --abort
```

If you are unsure about a conflict resolution, abort the rebase and reassess;
do not create a backup branch. During implementation and after intermediate
rebases that will be followed by more edits, run only focused checks for the
affected behavior. If a check fails, rerun the smallest corresponding test
first, then expand to the affected package or subsystem.

Once implementation is frozen:

```bash
git fetch origin
git rebase origin/main
git diff origin/main...HEAD
# Run focused checks for the affected behavior, then run the complete gate once.
make check
```

## Integration Back To Main

Once the feature branch is ready and the final checks are green:

```bash
git switch main
git fetch origin
git pull --ff-only

# Fetch/pull again immediately before integration and publication. If origin/main advanced,
# return to the feature worktree, rebase, inspect the diff, and rerun the
# necessary focused checks before retrying integration.
git fetch origin
git pull --ff-only
git merge --ff-only "$BR"
git push origin main
```

There is no exact-main pre-push hook in this repository. The complete `make
check` gate belongs to the final, frozen feature tip before fast-forwarding it
into `main`; main publication must push the full current local tip and then
verify the resulting main Actions run.

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
- Integration and conflict resolution must preserve the semantic intent of all involved branches, not just produce text that compiles.
- Before resolving merge or rebase conflicts, review the substantive commits on each side for new features, bug fixes, behavior changes, tests, and user-facing workflows.
- Do not drop, overwrite, or silently weaken current or historical functionality unless the user explicitly approves that product decision.
- If two branches introduce incompatible behavior, surface the product or architecture tradeoff instead of choosing one side silently.
- After resolving conflicts, run focused checks for the affected behavior; the complete repository gate remains reserved for the final frozen tip.
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
- For behavior conflicts that are not obvious from conflict markers, inspect the relevant commit history and tests so that fixes and existing product behavior are not regressed.
- If you are not confident about the result, abort the rebase and reassess.
- After conflict resolution, review `git diff origin/main...HEAD` before continuing.

## Temporary Documents

- Temporary planning notes, checklists, scratch documents, and investigation drafts are allowed during development.
- They must not be committed.
- Prefer storing them outside the repository.
- If they must exist inside the repository during work, keep them under a path ignored by Git and make sure `git status` is clean before integration.

## Local Quality Gate

- CI is the source of truth.
- The complete gate is a final integration check, not an intermediate rebase
  check. After the final rebase and focused validation, run it once before the
  fast-forward merge:

```bash
make check
```

- `make check` is expected to cover the core Go and web checks for this repository.

## Real Product Behavior Acceptance

- A change that affects a runtime, Desktop or web UI startup, cross-process
  communication, persistence, or another user-visible integration flow is not
  complete merely because unit tests or `make check` pass.
- Reproduce the affected behavior before editing, then add the smallest useful
  automated regression test and verify the real product flow after the fix.
- Real-product smoke tests must use a task-owned state directory, user-data
  directory, cache directory, temporary directory, processes, and dynamically
  reserved ports. Never reuse a shared development state directory or default
  port, and never stop processes owned by another task.
- Exercise the actual user operations affected by the change, including their
  observable UI and protocol results. Mock-only, source-only, and process-
  readiness checks do not replace this evidence.
- When startup recovery or persisted state is in scope, reuse the same isolated
  task state for a cold restart and verify the affected operation again.
- The smoke runner must clean up only its own processes and verify that its
  ports are released. Keep an actionable report with the tested commit, state
  path, ports, results, and failure logs or screenshots.
- Report the work complete only after the focused tests, the applicable real-
  product smoke, and the repository's final quality gate have passed on the
  final frozen feature tip. If real execution is externally blocked, document
  the blocker explicitly instead of claiming completion.

## Commit Messages

Use Conventional Commit messages for every commit:

```text
<type>(<scope>): <summary>
```

Use English, a lowercase type, an explicit scope naming the affected area, an
imperative lowercase summary, and no trailing period. Prefer `feat`, `fix`,
`docs`, `test`, `refactor`, `chore`, `build`, or `ci`.

## Release / Tag Rules

- Top-level repository and npm releases use tags in the form `vX.Y.Z`, such as
  `v0.4.1`.
- The `terminal-go` Go module uses tags in the form `terminal-go/vX.Y.Z`, such
  as `terminal-go/v0.8.3`.
- Create release tags only on a main commit that has been pushed and whose
  required checks have completed. After pushing a tag, verify the release
  workflow and the resulting npm registry or Go proxy artifacts are available.

## Repository Rule File

- `AGENTS.md` is the canonical repository rule file for this repository.
- Do not add or keep a committed repository-level `.develop.md` here.
