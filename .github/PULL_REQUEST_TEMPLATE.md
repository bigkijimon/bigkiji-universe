## What this changes

<!-- One or two sentences. Behaviour, not diff. -->

## Why

<!-- What was wrong, or what became possible. Link the issue if there is one. -->

## How it was checked

<!-- Paste the output. "npm test" alone is fine if that is genuinely what you ran. -->

```
$ npm test
```

## Checklist

- [ ] `npm test` is green (61 selftests)
- [ ] Added or updated a selftest under `tools/` for the changed behaviour
- [ ] No new runtime dependency (or it was agreed in an issue first)
- [ ] No test depends on network access, a provider key, or a home directory
