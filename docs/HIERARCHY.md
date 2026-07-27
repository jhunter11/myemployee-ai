# Hierarchical Agent Orchestration

Drawing from LangGraph's Supervisor Hub and CrewAI's hierarchical delegation patterns, the Jarvis framework utilizes a tiered, tree-like agent structure to manage complexity and ensure strict isolation.

## The Agent Tree

### 1. The Gateway (Level 1)
- **Role:** The Express.js API gateway. It receives webhooks from external services or manual triggers from the control UI.
- **Function:** Determines the Tenant ID and routes the payload to the correct internal system or directly invokes the Jarvis Supervisor.

### 2. Jarvis Supervisor (Level 2)
- **Role:** The `main` OpenClaw orchestrator.
- **Function:** Analyzes top-level directives (e.g., "Onboard a new client"). Instead of executing the work directly, Jarvis delegates tasks to specialized Level 3 workers. It evaluates their output and reports back to the user.

### 3. Agency Workers (Level 3)
- **Role:** Internal, specialized OpenClaw sub-agents.
- **Examples:**
  - `scaffold_worker`: Strictly handles running `scaffold-client.sh` and configuring sandbox boundaries.
  - `audit_worker`: Runs nightly scans for security vulnerabilities or broken tests.
  - `pr_reviewer`: Evaluates feature branch diffs against agency SOPs.
  - `toolsmith_worker`: Analyzes the `task_frequency_log` during audits to discover new tools on GitHub or autonomously author new OpenClaw skills when manual workflows become repetitive.

### 4. Client Supervisors (Level 4)
- **Role:** A dedicated manager agent for a specific client (e.g., `client_a_supervisor`).
- **Function:** When the API Gateway triggers a client automation, it invokes this supervisor. The supervisor understands the client's global context (memory, SOPs) and delegates sub-tasks to the client's specific workers.

### 5. Client Workers (Level 5)
- **Role:** Task-specific agents strictly bound to the client's sandbox.
- **Examples:**
  - `client_a_scraper`: Allowed to use web tools, but denied access to email tools.
  - `client_a_emailer`: Allowed to use the `himalaya` tool, but denied access to web tools.
- **Function:** Executes atomic tasks and returns results to the Client Supervisor for aggregation.

## Routing Logic
Code executing at `src/agents/supervisor.ts` acts as the router. It parses the objective, decides which worker to invoke, passes the necessary context, and collects the results.
