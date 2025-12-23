# Deal Engine V0 Test Fixtures

Minimal JSON fixtures for each of the 13 template types in `template_library_v1.json`.

## Running Validation

```bash
pnpm validate:deal-engine-fixtures
```

Fixture Naming Convention

{template_id_lowercase}.min.json

Each fixture is the minimal valid payload for that template type.

Adding New Fixtures

1. Create JSON file following the schema in contracts/deal_engine_v0.schema.json
2. Run validation to ensure it passes
3. Commit
