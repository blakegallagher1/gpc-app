# Codex Manager Workflows

Detailed workflow patterns for the manager/architect role.

## Example: Implementing a New Feature

### Scenario
User asks: "Add a user authentication system to my Express app"

### Manager Workflow

**Step 1: Reconnaissance**
Use reads/greps to understand the current codebase before delegating.

```bash
Read package.json
Glob **/routes/*.js
Grep "app.use|router" .
Read src/app.js
```

**Step 2: Planning (Internal)**
Determine the implementation order:
1. Install dependencies (bcrypt, jsonwebtoken)
2. Create user model
3. Create auth routes (register, login)
4. Create auth middleware
5. Protect existing routes

**Step 3: Delegate - Install Dependencies**
```bash
./scripts/codex-task.sh --mode full-auto "Run: npm install bcrypt jsonwebtoken

Then update package.json to include these as production dependencies.

Execute now."
```

**Step 4: Verify**
```
Read package.json
```

**Step 5: Delegate - Create User Model**
```bash
./scripts/codex-task.sh --mode full-auto "Create a User model in src/models/user.js

Requirements:
- Use mongoose schema
- Fields: email (unique, required), password (hashed), createdAt
- Pre-save hook to hash password with bcrypt
- Method to compare passwords

Create the file now."
```

**Step 6: Verify**
```
Read src/models/user.js
Grep "bcrypt" src/models/user.js
```

Continue this pattern for each component with verification gates.

## Example: Fixing a Bug

### Scenario
User reports: "The login endpoint returns 500 error when email doesn't exist"

### Manager Workflow

**Step 1: Understand the Bug**
```bash
Read src/routes/auth.js
Grep "login|findOne" .
```

**Step 2: Identify Root Cause**
After reading: the code assumes user exists and accesses user.password without null check.

**Step 3: Delegate Fix**
```bash
./scripts/codex-task.sh --mode full-auto "Fix bug in src/routes/auth.js login route.

Problem: No null check after User.findOne(). When user doesn't exist, accessing user.password throws error.

Solution: Add check for null user and return 401 with 'Invalid credentials' message.

Apply fix now."
```

**Step 4: Verify Fix**
```bash
Read src/routes/auth.js
Grep "if.*\!user|if.*user.*null" src/routes/auth.js
```

**Step 5: Request Test**
```bash
./scripts/codex-task.sh --mode full-auto "Run the auth tests to verify the login fix works.

Command: npm test -- --grep 'login'

Report the results. If failures exist, fix and rerun until clean."
```

## Example: Refactoring

### Scenario
User wants: "Extract the database connection logic into a separate module"

### Manager Workflow

**Step 1: Find Current Implementation**
```bash
Grep "mongoose.connect|createConnection" .
Read src/app.js
```

**Step 2: Delegate Extraction**
```bash
./scripts/codex-task.sh --mode full-auto "Refactor database connection in src/app.js.

Current: Connection logic is inline in app.js
Target: Create src/config/database.js that exports a connect function

Steps:
1. Create src/config/database.js with the connection logic
2. Export an async connect() function
3. Update src/app.js to import and call connect()
4. Maintain all existing environment variable usage
5. Keep diff minimal; do not refactor unrelated code

Apply changes now."
```

**Step 3: Verify Both Files**
```
Read src/config/database.js
Read src/app.js
```

**Step 4: Test Application Starts**
```bash
./scripts/codex-task.sh --mode full-auto "Start the application and verify it connects to the database.

Command: npm start

Report if connection succeeds. If it fails, fix and retry."
```

## Verification Checklist

After each Codex action, verify:

### For New Files
- [ ] File created at correct path
- [ ] Expected exports/structure present
- [ ] No syntax errors
- [ ] Follows project conventions

### For Modifications
- [ ] Changes match the request
- [ ] No unintended side effects
- [ ] Existing functionality preserved
- [ ] Imports/exports updated correctly

### For Deletions (avoid unless required)
- [ ] References updated
- [ ] No broken imports
- [ ] Tests still pass

### For Bug Fixes
- [ ] Root cause addressed
- [ ] Edge cases handled
- [ ] Tests pass (or added if missing)

## Escalation Patterns

If Codex produces incorrect output multiple times:

**Be more specific**
```bash
./scripts/codex-task.sh --mode full-auto "I need you to do EXACTLY this:

In file: src/utils/helper.js
At/near line: 42
Change: const result = data.map(x => x.id)
To: const result = data.filter(x => x.active).map(x => x.id)

Make this exact change now."
```

**Provide context**
```bash
./scripts/codex-task.sh --mode full-auto "Context:
- This is a React 18 app with TypeScript
- We use React Query for data fetching
- Components are functional using hooks

Now implement: [task]. Apply changes now."
```

**Break down further**
Instead of one complex task, issue multiple simple tasks with verification gates.

## Using the Helper Script

The scripts/codex-task.sh script helps enforce timeouts and standardizes autonomy mode.

**Quick Fix (Short Timeout)**
```bash
./scripts/codex-task.sh -t 2 "Fix typo in README.md"
```

**Heavy Implementation (Long Timeout)**
```bash
./scripts/codex-task.sh -t 8 "Implement the full OAuth flow in auth.service.ts including error handling and retry logic. Keep diff minimal."
```

**Quiet Background Check**
```bash
./scripts/codex-task.sh -q "Check if port 3000 is in use. If it is, print which process is holding it."
```

**Conservative Mode**
```bash
./scripts/codex-task.sh --mode controlled "Run the linter and tests. Request approval before running any destructive commands."
```
