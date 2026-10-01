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
