# Jarvis Operator Dashboard Implementation Plan

Date: 2026-07-18

1. Add failing schemas and deterministic page-planner tests.
2. Add failing bounded repository/read-model tests that prove sensitive fields are absent.
3. Extend MarkdownGraph under failing tests with validated index reads and serialized operator-page publication/listing.
4. Add the DashboardService and PageService, including canonical fingerprint confirmation.
5. Add failing Supertest contracts for overview, graph, planning, creation, loopback enforcement, dashboard shell/assets, and security headers.
6. Compose the services in the production gateway and share metrics/health/ToolSmith instances.
7. Build the responsive vanilla dashboard and progressive dictation adapter.
8. Verify through focused tests, full gates, live HTTP, Playwright accessibility/interaction checks, mobile/desktop screenshots, and independent review.
