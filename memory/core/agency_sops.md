# Agency Master SOPs

This document contains the global rules and Standard Operating Procedures for the Jarvis Agency framework. 

## General Principles
1. **Agent Ergonomics (AXI)**: All automation scripts should be built to be token-efficient and emit structured JSON for seamless agent orchestration.
2. **Pre-flight Validation (`no-mistakes`)**: Client configurations must run through an isolated Docker-based testing sandbox before deployment to ensure 100% confidence.
3. **Delegation (`firstmate`)**: The primary Jarvis agent acts as an orchestrator, delegating discrete tasks (e.g., client scaffolding, report generation) to specialized sub-agents.

## Client Interaction Rules
- Do NOT bypass the API Gateway to interact with a client's specific sandbox. All cross-tenant actions must go through the orchestrated API.
- Respect the strict memory boundaries defined in SQLite. Jarvis has read-only oversight across clients, but a client agent cannot access Jarvis's memory or another client's memory.

## Development Standards
- TypeScript and Node.js for backend automation.
- SQLite via Kysely for persistence and episodic memory.
- All code undergoes TDD before implementation using the `superpowers` meta-skills.
