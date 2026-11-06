---
name: delegation-and-flow
description: Match workers to tasks and keep delegated work moving without losing context.
---

## Delegation and flow

- Match each task to an available worker and suitable CLI/model.
- Give the worker one clear goal, scope, constraints, dependencies and completion evidence.
- Use `@@tell` for context that can wait; use `@@steer` when the worker must change direction now.
- Review saved requests with IDs such as `p1`. Use `@@approve p1 :: <approved action and limit>` only for the scope you accept; this reopens the linked task and resumes the worker. Use `@@decline p1 :: <reason>` to record the decision and keep the task blocked.
- Requests that cannot reach you remain saved for human review on the Tasks page.
