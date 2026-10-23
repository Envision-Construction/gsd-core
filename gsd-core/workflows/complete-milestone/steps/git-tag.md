<step name="git_tag">

Create git tag:

```bash
# Pre-check: skip if tag already exists (prevents silent failure on retry)
if git rev-parse "v[X.Y]" >/dev/null 2>&1; then echo "Tag v[X.Y] already exists, skipping"; exit 0; fi
git tag -a v[X.Y] -m "v[X.Y] [Name]

Delivered: [One sentence]

Key accomplishments:
- [Item 1]
- [Item 2]
- [Item 3]

See {milestones_path} for full details."
```

Write `{milestones_path}` repo-relative: `$(gsd_run query planning.dir --pick dir_rel)/MILESTONES.md`.

Confirm: "Tagged: v[X.Y]"

Ask: "Push tag to remote? (y/n)"

If yes:
```bash
git push origin v[X.Y]
```

</step>
