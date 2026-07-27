# AI Agency Framework Architecture & Strategy

> **Historical/aspirational document:** This is an early strategy sketch, not a description of
> deployed Jarvis capability. References to model fallbacks, autonomous
> audits, self-healing, Kubernetes, pricing, and uptime are proposals unless separately proven by
> code and current runtime evidence. Use
> [revenue/agency-launch-roadmap.md](./revenue/agency-launch-roadmap.md) for the evidence-backed
> launch state and current decisions, and
> [operations/v1-operator-handoff.md](./operations/v1-operator-handoff.md) for the current local UI,
> profile-runtime, Telegram, and calendar connection truth.

This document outlines the end-to-end framework for building, scaling, and operating an AI Automation Agency. It covers technical infrastructure, multi-tenancy, memory isolation, pricing, and go-to-market strategies.

## User Review Required

> [!IMPORTANT]
> Please review this framework to ensure it aligns with your target market and technical capabilities. Feedback on the preferred cloud provider (AWS/GCP), local vs. cloud LLM preference, and your target niche for outreach will help refine this plan.

## Open Questions

> [!WARNING]
>
> 1. Do you prefer fully self-hosted open-source models (Llama 3, Qwen) on your own GPU clusters to maximize margins, or utilizing managed APIs (OpenAI, Anthropic) to reduce upfront capital expenditure?
> 2. What specific niche or industry are you initially targeting for your AI automations (e.g., Real Estate, E-commerce customer support, Legal tech)?
> 3. Do you have a preferred cloud provider (AWS, GCP, Azure, or bare metal providers like CoreWeave/Lambda Labs)?

---

## 1. Software & Architecture Framework

The core engine will utilize a multi-agent gateway (such as OpenClaw) that orchestrates tasks, routes to appropriate LLMs, and executes tools.

- **Gateway Layer:** A central API gateway that routes customer requests to specific AI agents.
- **Execution Runtime:** Use containerized environments (Docker) for agent execution to ensure tools and scripts run safely.
- **Agent SDK:** A standardized plugin system for developers to quickly build new "Skills" or integrations (e.g., Salesforce, Slack, HubSpot) that can be enabled per customer.

## 2. Hosting & Compute Clustering

To achieve scale and reliability, the infrastructure must be distributed and easily provisioned.

- **Compute Orchestration:** Kubernetes (K8s) is recommended for orchestrating containerized agent runtimes. This allows for horizontal scaling based on load.
- **LLM Clustering (If self-hosting models):** Use a distributed inference engine like **vLLM** or **TensorRT-LLM** deployed across a cluster of GPUs. Implement a load balancer (e.g., HAProxy or Nginx) to distribute token generation requests across multiple GPU nodes.
- **Stateless Agents:** Ensure the AI agent runtime is stateless. All state (conversations, tool results) should be written to a distributed database immediately, allowing any pod to pick up a paused workflow.

## 3. Multi-Customer Compartmentalization (Multi-Tenancy)

Data privacy and secure execution are the most critical components of an agency framework.

- **Compute Isolation:**
  - Use strict **Docker sandboxing** for any code execution or tool use.
  - For high-security clients, deploy dedicated Kubernetes namespaces or separate AWS VPCs.
- **Data Segregation:**
  - Implement Row-Level Security (RLS) in a shared PostgreSQL database, or use dedicated database instances per customer.
  - Encryption at rest using Customer-Managed Keys (CMK) via AWS KMS or HashiCorp Vault.
- **API Gateway Routing:** Every customer gets a unique API key and Tenant ID. The gateway injects the Tenant ID into all downstream service calls to strictly enforce data boundaries.

## 4. Per-Customer Memory and Profiles

Seamlessly adding a new customer requires a robust profile and memory system that automatically scopes context.

- **Vector Database (RAG):** Use a scalable vector database (e.g., Pinecone, Qdrant, or Milvus). **Strictly partition data using namespaces** (e.g., `namespace: "tenant_id_123"`).
- **System Prompts & Profiles:** Store customer-specific brand voices, SOPs (Standard Operating Procedures), and rules in a structured schema. When an agent is invoked for Customer A, the system dynamically compiles the system prompt using Customer A's Profile.
- **Episodic Memory:** Maintain isolated SQLite/Postgres tables for conversation history. Implement rolling summarization to compress long-term memory while keeping costs low.

## 5. Target Business Scale, Cost Structure & Pricing

To remain competitive while ensuring high margins, we will target the "Mid-Market Sweet Spot" (businesses with $1M - $50M in annual revenue). These businesses have capital to invest in efficiency but lack in-house AI engineering teams.

### Competitive Tiered Pricing Model

Instead of a one-size-fits-all model, we will offer scale-appropriate pricing:

1.  **Tier 1: Small Business (Process Optimization)**
    - _Target:_ Local services, small e-commerce ($500k - $2M revenue).
    - _Offering:_ 1-2 core automations (e.g., customer support triage, basic lead qualification).
    - _Pricing:_ $1,500 - $3,000 Setup Fee + $500/month Retainer (includes hosting and 10,000 API transactions).
2.  **Tier 2: Mid-Market (Department Automation)**
    - _Target:_ B2B services, mid-sized agencies, larger e-commerce ($2M - $50M revenue).
    - _Offering:_ Fully integrated AI workers (e.g., end-to-end sales outreach, comprehensive data entry and spreadsheet management).
    - _Pricing:_ $5,000 - $15,000 Setup Fee + $2,000/month Retainer (includes SLA, priority support, and dynamic scaling).
3.  **Tier 3: Performance/Hybrid (Risk-Reversal)**
    - _Pricing:_ Low setup fee (e.g., $1,000) but taking a percentage of revenue generated or flat fee per successful action (e.g., $10 per booked sales call). This makes the service highly competitive and easy to sell.

### Agency Cost Basis

- **Fixed Costs:** Base K8s cluster, Vector DB hosting, base GPU lease (if self-hosted).
- **Variable Costs:** LLM API tokens (in/out), dynamic compute scaling (AWS Fargate/EC2 spot instances).

## 6. Agent Directives (Continuous Competitiveness)

> [!IMPORTANT]
> The following directives are to be followed by any Implementation AI Agent (including myself) operating on behalf of this agency. These ensure the agency remains at the cutting edge of the market.

- **Directive 1: Proactive Competitor Research.** The agent must routinely evaluate newly released open-source models (e.g., Llama 3, Qwen) and API price drops. If a cheaper or faster model can accomplish a client's task with equal accuracy, the agent must propose an infrastructure migration to increase agency margins.
- **Directive 2: Prompt & Token Optimization.** The agent must automatically review client prompt templates and trim unnecessary tokens to reduce variable costs, passing those savings on to the agency's bottom line.
- **Directive 3: Value-Prop Generation.** When building a new automation, the agent must automatically generate a mini "Case Study Data Point" (e.g., "This script saves 4 hours a week") to be piped directly into the agency's marketing channels.
- **Directive 4: Seamless Onboarding.** When a new client is added, the agent will autonomously copy the boilerplate workspace template, provision the secure Sandbox environment in OpenClaw, and scaffold the client's API credentials without manual engineering intervention.

## 6. Outreach & Marketing Channel Strategy

To build the initial customer base, focus on high-ROI, pain-point-driven marketing.

- **The "Wedge" Strategy:** Don't sell "AI". Sell a specific solution to a specific problem (e.g., "We automate 80% of your overnight customer support tickets").
- **Channel 1: Outbound Cold Email & LinkedIn:**
  - Target operations managers and founders in specific niches (e.g., e-commerce, real estate).
  - Use personalized Loom videos demonstrating a mock AI agent solving their exact problem on their actual website.
- **Channel 2: Content Marketing (Case Studies):**
  - Build 2-3 internal automations or do pro-bono work for your first client.
  - Publish detailed case studies detailing the exact hours and dollars saved. Distribute these on Twitter/X, LinkedIn, and niche newsletters.
- **Channel 3: Strategic Partnerships:**
  - Partner with traditional marketing agencies or B2B consultants who don't have technical AI skills. Offer to white-label your AI infrastructure for their clients on a revenue-share basis.

## 7. Fenced-Off Workspace Configuration (Temporary Setup)

Before moving to a VPS, we will configure a temporary fenced-off workspace locally to simulate multi-tenancy securely. This will be implemented by modifying the local `openclaw.json` configuration:

- **Multi-Agent Partitioning:** We will define explicit customer agents (e.g., `client_a_agent`) within the `agents.list` configuration.
- **Isolated Directory Mounts:** Each agent will be assigned an isolated local workspace path (e.g., `~/.openclaw/workspaces/client_a`) mapped to their Docker sandbox.
- **Sandbox Scope:** We will enforce `sandbox.scope: "agent"` so that each client gets their own dedicated sandbox container, preventing cross-client data contamination during local testing.

## 8. Per-Profile Software Integrations

To make the service valuable, each client profile will have its own scoped software integrations enabled through OpenClaw's tool policies:

- **Email Integrations:** Enable the `himalaya` skill or a dedicated Gmail API script for specific client profiles, allowing the agent to read and draft emails on their behalf.
- **Spreadsheet & Document Editing:** We will provision sandbox environments with Python/Node.js so the agents can interact with the Google Sheets API, Excel, or local CSVs to process structured data.
- **Platform Integrations:** We will enable tools like `slack` or `trello` on a per-profile basis. The `openclaw.json` file will use `tools.allow` and `tools.deny` at the agent level to ensure Client A's agent cannot access Client B's Slack integration.

## 9. Agency Repository & "Jarvis" Ergonomics

To operate efficiently as a "Tony Stark & Jarvis" team, we will package this entire framework into a centralized, version-controlled repository (e.g., `ai-agency-jarvis`). This repository will be designed following the AI and agentic paradigms pioneered by leaders like **Kun Chen (kunchenguid)**:

- **AXI (Agent Ergonomics):** The repository will contain agent-native CLI scripts designed specifically for high token-efficiency. When I (your Jarvis agent) execute a client onboarding script, it will return dense, structured outputs to minimize token usage and maximize reasoning speed.
- **`no-mistakes` Validation Pipeline:** We will integrate pre-push AI validation. When I write a new custom spreadsheet or email automation for a client, it will run through an isolated test pipeline before being pushed, ensuring zero-defect deployments for clients.
- **`firstmate` Multi-Agent Orchestration:** We will adopt the "talk to one agent, ship with a crew" philosophy. You will talk to the `main` control agent (Jarvis), which will automatically delegate tasks to specialized OpenClaw sub-agents (e.g., an agent strictly for building the onboarding, an agent strictly for writing marketing case studies).
- **The Jarvis Repository Structure:**
  - `/config/`: Centralized storage of `openclaw.json` client sandbox blueprints.
  - `/scripts/`: Agentic shell scripts for auto-scaffolding new customers and optimizing tokens.
  - `/clients/`: Isolated directories for customer-specific scripts and integrations (strictly bounded by Docker).
  - `/docs/`: The architectural plans, task tracking, and pricing strategies for continuous agent alignment.

## 10. Model Routing & Fallback Strategies (Zero Downtime)

To ensure the AI agency is operational at all times and maximizes cost-efficiency (such as utilizing a flat-rate $20/month ChatGPT Plus subscription via OAuth instead of pay-per-token API), we will configure strict fallback routing in OpenClaw.

- **Primary Engine (OpenAI):** We will set the primary global model to `openai/gpt-5.4` (or `gpt-4o` depending on availability in your config). Using the OpenAI `oauth` profile allows the agent to route through your $20 web subscription rather than consuming API credits.
- **Tier 1 Fallback (Gemini):** If OpenAI hits a rate limit (e.g., GPT-4's message cap), OpenClaw will automatically catch the 429 error and route the prompt to `google/gemini-3.5-flash`.
- **Tier 2 Fallback (Local/Ollama):** If the internet drops or both cloud providers fail, the system will fall back to a local model running on your hardware (e.g., `ollama/qwen2.5-coder:7b`), ensuring 100% uptime for critical automations.

We will enforce this structure across all agents by modifying `agents.defaults.model` in your configuration.

## 11. Hierarchical Memory Architecture

To ensure strict data boundaries while maintaining operational oversight, we will implement a hierarchical memory access model across the agent pool:

- **Jarvis (Master Agent) Memory:** The `main` orchestrating agent maintains a global context window. Its memory includes overarching agency SOPs, global pricing logic, and a registry of all active clients.
- **Client Agent Memory (Isolated):** Each customer agent (e.g., `client_a_agent`) has a strictly isolated memory core (`~/.openclaw/agents/client_a/agent/openclaw-agent.sqlite`). When a client agent runs, it can **only** access its own localized memory (client-specific SOPs, task history, and CRM data) and is physically blocked by the Sandbox from reading Jarvis's overarching memory or other clients' data.
- **Top-Down Oversight:** While client agents are isolated, Jarvis operates with elevated permissions (`tools.allow: ["read"]` on all client directories). This allows Jarvis to proactively inject new operational guidelines into a client's memory, or summarize a client's memory database to generate a weekly health report for you, without the client agent ever piercing the master boundary.

## 12. Meta-Skills & The Superpowers Library

To elevate the Jarvis agents from simple task-runners to autonomous engineers, we must fill the current gaps in **Context Assembly** and **Meta-Reasoning**. We will achieve this by integrating the **[obra/superpowers](https://github.com/obra/superpowers)** skill library (and related meta-skills like `5-d-build`) directly into the agent workflow.

### Identified Gaps & How We Fill Them:

1. **Gap: Naive Code Generation**
   - _Solution (The `5-d-build` & Superpowers):_ Instead of prompting an agent to "write a script," we will equip them with meta-skills like `investigation-mode`, `root-cause-tracing`, and `verification-before-completion`. When building AI tools for clients, Jarvis will first load the `5-d-build` meta-skill to construct a multi-dimensional plan (Architecture, Tests, Edge-cases, Deployment, Maintenance) before writing a single line of code.
2. **Gap: Skill Provisioning**
   - _Solution:_ We will create a `skills/` directory inside `~/ai-agency-jarvis/`. We will clone the `obra/superpowers` library into this directory. When `scaffold-client.sh` provisions a new client, it will automatically mount this `skills/` directory into the client's OpenClaw sandbox as read-only.
3. **Gap: Context Injection (The "Context Hole")**
   - _Solution:_ Currently, the agents rely purely on their isolated SQLite memory. We need dynamic workspace awareness. We will integrate a repository mapping tool (like `repomap` or `tree`) as a meta-skill. Before executing a task, Jarvis will autonomously run the mapper to inject the exact structural context of the client's codebase into its prompt, preventing hallucinations.

## 13. Software Engineering Cycle (Agentic SDLC)

To stay on top of development and ensure that client automations don't degrade into spaghetti code, we will implement a strict **Agentic Software Development Life Cycle (SDLC)**. This workflow blends standard engineering practices with AI-native validation tools (like `no-mistakes` and OpenClaw's `autoreview` skill).

### The Agency Workflow Loop:

1. **Issue & Scope (The Input):**
   - Every client request (e.g., "Automate my lead emails") begins as a GitHub Issue in the `ai-agency-jarvis` repo.
   - Jarvis reads the issue and triggers the `5-d-build` meta-skill to generate a multi-dimensional spec document before touching the codebase.
2. **Feature Branching:**
   - Development occurs on isolated feature branches (e.g., `git checkout -b feature/client-b-email-bot`).
   - Code is strictly developed inside that client's sandboxed `workspace/`.
3. **Pre-Push Validation (`no-mistakes` Pipeline):**
   - Before pushing code, we will enforce a strict pre-commit/pre-push pipeline. The AI must autonomously run unit tests (using frameworks like `vitest` or `pytest`) and run formatters.
   - If the code throws an error, the agent transitions to `investigation-mode` and traces the root cause before attempting the commit again.
4. **Automated PR Review (`autoreview`):**
   - When the branch is pushed and a Pull Request is created, we will utilize OpenClaw's native `autoreview` skill. A specialized sub-agent will read the PR diff, check it against the client's SOPs, and either approve it or request changes automatically.
5. **Merge & Deployment:**
   - Once approved, the code is merged to `main`. Since client workspaces are volume-mounted to their configurations, pulling `main` into the production server immediately updates the client's automation.

## 14. Automated Audit Cycles & Self-Healing

To achieve true scale, we cannot rely on manual vulnerability analysis. The framework must autonomously search for its own bugs and patch 95% of them before you even wake up. We will implement **Automated Audit Cycles** using scheduled cron jobs.

### The Cyclic Workflow:

1. **The Cron Trigger:**
   - We will configure background recurring schedules (e.g., Nightly at 2:00 AM).
   - When the cron fires, it sends a high-priority system wake-up call to Jarvis to initiate the "Nightly Audit."
2. **Auditor Sub-Agents:**
   - Jarvis delegates the audit to specialized OpenClaw sub-agents using the `firstmate` paradigm.
   - _Security Auditor:_ Scans all active client sandboxes and the main repository for plaintext secrets or unauthenticated API routes.
   - _Quality Auditor:_ Reviews recent commits across all feature branches to ensure unit tests exist and the `5-d-build` specs are being followed.
3. **Automated Ticketing:**
   - When an auditor finds a bug or a missing spec, it does not stop operation. It autonomously parses the finding and appends it to `docs/KANBAN.md` under a new `🐛 Automated Bug Reports` section.
4. **The 95% Self-Healing Phase:**
   - For standard bugs (e.g., linter failures, minor logic errors, missing tests), Jarvis will automatically transition into `investigation-mode`, write the patch, and open a Pull Request using the `autoreview` pipeline.
   - This ensures that 95% of operational friction is handled by the AI, leaving you to only review the final 5% of critical architectural changes.

## 15. Automated Self-Improvement Loop (The ToolSmith)

To prevent the agency from stagnating and to automate the discovery of new operational efficiencies, we will implement an autonomous **ToolSmith Workflow**.

1. **Repetitive Task Logging:** When the execution engine runs tasks, it logs their signatures and frequency to `task_frequency_log` in the global database.
2. **Analysis & Discovery:** During the nightly audit, a specialized `toolsmith_worker` analyzes this log. If a specific manual task or high-friction task exceeds a frequency threshold, the agent uses `search_web` and `grep_search` to scan the local `~/openclaw` repository and public GitHub for existing scripts, MCP servers, or tools that solve this problem.
3. **Autonomous Generation:** If no existing solution is found, the ToolSmith transitions into the `5-d-build` workflow to write a brand new OpenClaw skill or TypeScript automation script, test it, and open a Pull Request for the owner to review. This ensures the agency writes its own tools while you sleep.

## 16. Mobile Administration (Telegram Check-In)

Telegram is an **implemented opt-in adapter**, but no bot credential or private chat is configured
by the repository. It is disabled by default, loads the token only from macOS Keychain, calls the
same bounded Jarvis responder through a strict command service, and receives no independent
authority.

- **Mobile Command Hub:** Private-chat allowlisting, authenticated principal binding, transactional update deduplication, a durable polling cursor, and redacted inbox evidence are implemented. Live activation still requires one exact positive user/private-chat pair and a Keychain bot token.
- **Operational Control:** Initial commands are bounded reads plus an exact pause proposal. Telegram cannot approve or execute the proposal, and free text never selects a tenant, scope, or capability.
- **Customer Portal Boundary:** Client-facing channels require separate tenant-scoped identities and authorization; the owner's future Telegram adapter is not a reusable client portal by itself.

---

## Verification Plan

1. **Feedback Loop:** Verify the local web chat first. Telegram code-level replay, allowlist,
   restart, and redacted-audit tests exist; external verification begins only after the operator
   deliberately installs a Keychain credential and exact private-chat allowlist.
2. **Repository Packaging:** I will instantiate the `ai-agency-jarvis` git repository, migrate our plans and configurations into it, and scaffold the Agent Ergonomics structure.
3. **Fallback & Memory Configuration:** Once approved, I will commit the final Hierarchical Memory architecture documentation to the `ai-agency-jarvis` repo, ensuring the blueprint dictates strict `agentDir` boundaries for OpenClaw.
4. **Skill Library Integration:** Upon your approval, I will scaffold the `skills/` directory in the Jarvis repo and pull in the Superpowers methodologies.
5. **Workflow Scaffolding:** Once the SDLC is approved, I will create a `docs/WORKFLOW.md` playbook in the repo and optionally set up a pre-commit hook to enforce the `no-mistakes` pipeline.
6. **Cycle Execution:** Once approved, I will initiate the `schedule` cron job within OpenClaw to permanently establish this background audit loop.
7. **Mobile Sync:** After a live Telegram connection is deliberately activated and verified, record
   its exact authority and restart/replay evidence without storing credentials or personal
   identifiers in the repository.
