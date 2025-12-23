# Codex Anti-Pattern Detection

As a manager, watch for these common mistakes from the intern.

## 1. OVER-ENGINEERING

**Symptoms:**
- Unnecessary abstractions (factories, strategies) for simple logic
- New helpers/utils used only once
- Config flags/features not requested
- Premature optimization (caching, complex algorithms) without need

**Guidance:**
Keep it simple. Implement exactly what was asked. YAGNI.

## 2. INCOMPLETE WORK

**Symptoms:**
- TODOs left behind
- Partial implementations (function shells)
- Missing error handling that was requested
- Forgetting exports/imports

**Guidance:**
Finish the task. No TODOs. Verify error paths.

## 3. EXCITEMENT SPRAWL

**Symptoms:**
- Modifying files not related to the task
- Refactoring unrelated code "while here"
- Adjacent "improvements" not requested

**Guidance:**
Stay in scope. Touch only what is required. Keep diff minimal.

## 4. COPY-PASTE ERRORS

**Symptoms:**
- Duplicated blocks with slight variations
- Inconsistent naming conventions
- Placeholder text left behind
- Wrong variable names copied from elsewhere

**Guidance:**
Review carefully. Remove artifacts. Ensure naming consistency.

## 5. SECURITY BLINDSPOTS

**Symptoms:**
- Hardcoded secrets (keys/tokens/passwords)
- Missing input validation
- Injection vulnerabilities
- Sensitive data in logs

**Guidance:**
Security first. Never hardcode secrets. Validate/sanitize inputs. Avoid leaking data.

## 6. VERIFICATION COMMANDS (MANAGER CHECKS)

**Over-Engineering**
- Detect complex patterns: `grep -rE "Factory|Builder|Strategy|Singleton" src/ || true`
- Check utility sprawl: `find src/ -name "util" -o -name "helper" -o -name "common" 2>/dev/null || true`
- Change magnitude: `git diff --stat`

**Incomplete Work**
- Leftovers: `grep -rnE "TODO|FIXME|XXX|HACK" . || true`
- Generic errors: `grep -rn "throw new Error" . || true`

**Excitement Sprawl**
- Changed files: `git diff --name-only`
- Diff stats: `git diff --stat`

**Copy-Paste Errors**
- Placeholders: `grep -rnE "foo|bar|example|test123" . || true`

**Security**
- Potential secrets: `grep -rnEi "password|secret|key|token" . || true`
- Dangerous calls: `grep -rnE "eval\(|exec\(|system\(" . || true`
