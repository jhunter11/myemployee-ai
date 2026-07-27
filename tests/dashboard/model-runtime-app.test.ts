import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..', '..');
const app = readFileSync(join(projectRoot, 'public', 'dashboard', 'assets', 'app.js'), 'utf8');
const shell = readFileSync(join(projectRoot, 'public', 'dashboard', 'index.html'), 'utf8');
const styles = readFileSync(
  join(projectRoot, 'public', 'dashboard', 'assets', 'styles.css'),
  'utf8'
);

describe('dashboard model subscription browser contract', () => {
  it('loads model runtime through the ordinary resilient chat source lifecycle', () => {
    expect(app).toContain("modelRuntime: '/model-runtime'");
    expect(app).toContain("if (source === 'modelRuntime')");
    expect(app).toContain("modelRuntime: ['#model-runtime-providers']");
    expect(app).toContain('function renderModelRuntime()');
    expect(app).toContain('CORE.modelRuntimePresentation(state.modelRuntime)');
    expect(app).toContain("applySourceSettlement('modelRuntime', settlement, sequence)");
    expect(app).toContain('modelRuntimeLoadSequence: 0');
    expect(app).toContain('function nextModelRuntimeLoadSequence()');
    expect(app).toContain("source === 'modelRuntime' ? nextModelRuntimeLoadSequence() : sequence");
  });

  it('renders a compact accessible connection strip before the exact-agent workbench', () => {
    expect(shell).toContain('aria-labelledby="model-runtime-heading"');
    expect(shell).toContain('id="model-runtime-providers"');
    expect(shell).toContain('id="model-runtime-disable"');
    expect(shell).toContain('id="model-runtime-status"');
    expect(shell.indexOf('id="model-runtime-heading"')).toBeLessThan(
      shell.indexOf('class="agent-workbench"')
    );
    expect(shell).toContain('Claude and OpenAI / ChatGPT');
    expect(shell).not.toContain('no model tokens or external sends');
    expect(styles).toContain('.model-runtime-panel');
    expect(styles).toContain('.model-runtime-providers');
    expect(styles).toContain('#model-runtime-disable[hidden]');
    expect(styles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.model-runtime-providers[\s\S]*?overflow-x: auto/u
    );
  });

  it('uses only fixed provider controls and exact versioned mutation bodies', () => {
    expect(app).toContain("const MODEL_PROVIDER_IDS = Object.freeze(['claude', 'openai'])");
    expect(app).toContain('button.dataset.modelProvider');
    expect(app).toContain('MODEL_PROVIDER_IDS.includes(provider)');
    expect(app).toContain('`/model-runtime/providers/${encodeURIComponent(provider)}/login`');
    expect(app).toContain("request('/model-runtime/select'");
    expect(app).toContain('body: JSON.stringify({ provider, expectedVersion: runtime.version })');
    expect(app).toContain("request('/model-runtime/disable'");
    expect(app).toContain('body: JSON.stringify({ expectedVersion: runtime.version })');
    expect(app).not.toContain('.innerHTML');
  });

  it('polls after login, reconciles every mutation, and announces outcomes', () => {
    expect(app).toContain('function scheduleModelRuntimePoll(');
    expect(app).toContain('MODEL_RUNTIME_POLL_INTERVAL_MS');
    expect(app).toContain('MODEL_RUNTIME_POLL_ATTEMPTS');
    expect(app).toContain('await reconcileModelRuntime()');
    expect(app).toContain('announce(state.modelRuntimeNotice)');
    expect(app).toContain(
      'Connection status could not be refreshed. Jarvis will check again briefly.'
    );
    expect(app).toContain('finally');
  });

  it('extends only the actual message request timeout for subscription responses', () => {
    expect(app).toContain('const REQUEST_TIMEOUT_MS = 10_000');
    expect(app).toContain('const MODEL_CHAT_TIMEOUT_MS = 120_000');
    expect(app).toContain('async function request(path, options, timeoutMs = REQUEST_TIMEOUT_MS)');
    expect(app).toMatch(
      /\/messages`,\s*\{[\s\S]*?expectedVersion: conversation\.version[\s\S]*?\},\s*MODEL_CHAT_TIMEOUT_MS\s*\)/u
    );
    expect(app).toContain('Local dashboard request timed out after');
  });

  it('keeps the dynamic subscription badge limited to exact Jarvis selection', () => {
    expect(app).toContain('CORE.agentRuntimePresentation(profile, state.modelRuntime)');
    expect(app).toContain("$('#agent-runtime-badge')");
  });
});
