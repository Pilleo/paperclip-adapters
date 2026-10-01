# Real Git conflict qualification

## Mergeability boundary

The local GitHub fixture now computes open-PR mergeability using real
`git merge-tree --write-tree main <head>` observations. Exit zero becomes
`MERGEABLE/CLEAN`; a genuine conflict becomes `CONFLICTING/DIRTY`.
Other Git failures remain observation failures. The probe does not alter the
checkout, index, branch head or PR head. Closed/merged PR mergeability is unknown.

The failing-first regression seeds a shared export line, branches B and C from
that base, then publishes C as a standard two-parent merge. Real Git reports a
conflict for B, and both `gh pr view` and inventory now expose it. A separate
disjoint-file case proves that base advancement alone remains mergeable, while
the fixture's stale-base merge authorization fence stays in place.

The existing complete autonomous A→B daemon case also passed against the new
boundary in **385.446 seconds**:
`~/.local/state/agent-output/run-xkt6my75/`.
It retained native reviews, restart, human waits, user merge, dependency release,
and zero post-start driver writes. This proves compatibility with the faithful
Git boundary; autonomous conflict remediation remains the next qualification.

## Provider repair and reviewed-head fence

The fixture can seed shared code before its initial commit and publish PR branches
to the real local bare remote. Its explicit provider repair actor uses a separate
Git worktree, merges the advanced base into the original PR branch, resolves the
declared file and publishes a new head. The project checkout and index remain
untouched. Unresolved conflicts and unexpected Git failures propagate.

The repaired-head regression executes the JavaScript exports and verifies
`increment(8) = 9`, `decrement(8) = 7`, and the external contributor's
`double(8) = 16`. The repair commit has the old PR head and advanced base as its
two parents; mergeability becomes clean. The old reviewed SHA is refused by the
fixture's merge fence, and fresh evidence naming the new SHA permits a standard
merge. This is a Git-boundary proof; native review-card invalidation still requires
the forthcoming daemon case.

PR diff observation now uses the real two-way `main...head` diff. A failing-first
test caught the former combined merge-commit diff, which would have given native
reviewers the wrong view of a repaired PR. All six Git-boundary tests pass.
