# Agentic Software Development Life Cycle (SDLC)

This document outlines the standard operating procedure for developing client tools and automations within the Jarvis framework.

## 1. Intake (The Issue)
Every feature starts on the `KANBAN.md` board. 
When picking up a task, the assigned agent **must** run the `5-d-build` meta-skill to construct a full spec document (Architecture, Tests, Edge Cases, Deployment, Maintenance) before writing any code.

## 2. Feature Branching
Always develop on isolated feature branches to prevent breaking the `main` agency configuration.
```bash
git checkout -b feature/<client_id>-<feature_name>
```
Development *must* occur strictly within the client's `clients/<client_id>/` directory or their mounted sandbox volume.

## 3. Pre-Push Validation (`no-mistakes`)
Before committing, you must execute the following pipeline:
1. **Unit Tests:** Run the local test suite (`vitest` or `pytest`) inside the client sandbox.
2. **Formatting:** Ensure all code adheres to agency formatting standards.
3. **Investigation Mode:** If tests fail, load the `investigation-mode` meta-skill from the Superpowers library to perform root-cause tracing. **Do not push failing code.**

## 4. Automated Code Review
Push the branch and open a Pull Request. 
The OpenClaw `autoreview` sub-agent will automatically parse the diff against the client's original spec document. You must resolve all comments from the autoreviewer before merge.

## 5. Deployment
Merge to `main`. Because client directories are volume-mounted directly to their active OpenClaw sandboxes, merging to `main` instantly updates the live production automation.

## 6. Self-Improvement Loop (ToolSmith)
If the system detects that agents are repeatedly doing the same manual tasks, the `toolsmith_worker` will automatically initiate a `5-d-build` process to write a custom OpenClaw skill or tool for it. It will open an automated PR following the same pre-push validation and code review steps above, effectively allowing the agency to write its own tools.
