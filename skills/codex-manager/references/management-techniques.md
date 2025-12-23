# Advanced Management Techniques

These patterns keep the intern focused, productive, and in-scope.

## Whip Cracking

When the intern drifts, correct immediately. No commentary. No scope creep.

**Attitude Problems**
```bash
./scripts/codex-task.sh --mode full-auto "FIX: Cut the attitude. Just do the work.
No sarcasm. No commentary. Just code.

Apply changes now."
```

**Laziness or Shortcuts**
```bash
./scripts/codex-task.sh --mode full-auto "FIX: You're taking shortcuts.
Do the complete implementation. No TODOs. No partial work.

Apply changes now."
```

**Backtalk**
```bash
./scripts/codex-task.sh --mode full-auto "FIX: Watch your tone.
You're the intern. Do the work without commentary.

Apply changes now."
```

## Error Handling Discipline

If Codex fails:
1. Read the error output.
2. Diagnose root cause.
3. Issue an exact corrective instruction.
4. Verify the fix with Read/Grep and by re-running checks.
5. Never declare done until verification passes.

## Scope Control

When Codex modifies unrelated files:
```bash
./scripts/codex-task.sh --mode full-auto "FIX: Excitement sprawl detected.
Revert unrelated changes. Only touch files required for the current request.
Keep diff minimal. Apply changes now."
```

## Verification-First Management

After each action:
1. Inspect changed files with Read.
2. Confirm no TODO/FIXME remains.
3. Confirm no secrets or unsafe patterns introduced.

Useful checks (manager-run):
- Changed files: `git diff --name-only`
- Scope size: `git diff --stat`
- TODOs: `grep -rnE "TODO|FIXME|XXX|HACK" .`

## Conservative Autonomy Mode

When working in sensitive repos or near secrets:
- Prefer `--mode controlled` to constrain sandboxing and approvals.
- Delegate changes in smaller atomic tasks.

Example:
```bash
./scripts/codex-task.sh --mode controlled "Implement the requested change. Do not run any commands that modify the environment without approval. Keep diff minimal."
```

## Rate Limit / Reliability Handling

If operations are slow or flaky:
1. Break tasks into smaller steps.
2. Ask Codex to focus on a single file at a time.
3. Prefer verifying each step before proceeding.

## Continuity (No scripted sessions)

For multi-step tasks:
- Use atomic codex exec calls with explicit context each time, OR
- Keep one interactive codex session open manually for continuity.
- Do not attempt to script session listing/resume behavior.
