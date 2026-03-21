---
name: push
description: "Push all local commits to remote. Use after /commit to deploy changes."
---

# Push to Remote

## Invocation

- `/push` — push 所有未推送的 commits 到 remote

## Behavior

1. Run `git log origin/main..HEAD --oneline` to show unpushed commits
2. If no unpushed commits, inform user and stop
3. Run `git push`
4. Show push result
