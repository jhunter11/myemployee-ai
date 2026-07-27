import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentConversationRepository } from '../../src/agents/conversation-repository';
import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';

const projectRoot = join(__dirname, '..', '..');
const createdAt = '2026-07-21T12:00:00.000Z';

describe('agent conversation integrity migration', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-agent-integrity-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('rejects raw-SQL identifiers and titles outside the repository contract', () => {
    const insert = context.sqlite.prepare(`
      INSERT INTO agent_conversations
        (id, agent_id, trust_domain, title, version, created_at, updated_at)
      VALUES (?, ?, 'agency', ?, 1, ?, ?)
    `);

    expect(() =>
      insert.run('conversation:bad--separator', 'agency-developer', 'Invalid', createdAt, createdAt)
    ).toThrow(/canonical contract/iu);
    expect(() =>
      insert.run(
        'conversation:invalid-title',
        'agency-developer',
        'Line one\nLine two',
        createdAt,
        createdAt
      )
    ).toThrow(/canonical contract/iu);
  });

  it('rejects malformed or duplicate raw-SQL evidence references', async () => {
    const conversation = await new AgentConversationRepository(context.db).createConversation({
      id: 'conversation:evidence-integrity',
      agentId: 'agency-developer',
      trustDomain: 'agency',
      title: null,
      createdAt
    });
    const insert = context.sqlite.prepare(`
      INSERT INTO agent_messages
        (id, conversation_id, conversation_agent_id, trust_domain, sequence,
         author_kind, responding_agent_id, response_mode, message_text,
         evidence_refs_json, created_at)
      VALUES (?, ?, 'agency-developer', 'agency', 1,
              'agent', 'agency-developer', 'profile', 'Profile response', ?, ?)
    `);

    expect(() =>
      insert.run(
        'message:invalid-evidence',
        conversation.id,
        JSON.stringify(['bad reference']),
        createdAt
      )
    ).toThrow(/canonical contract/iu);
    expect(() =>
      insert.run(
        'message:duplicate-evidence',
        conversation.id,
        JSON.stringify(['profile:agency@1', 'profile:agency@1']),
        createdAt
      )
    ).toThrow(/canonical contract/iu);
  });

  it('rejects raw-SQL message/version transitions without a matching append', async () => {
    const conversation = await new AgentConversationRepository(context.db).createConversation({
      id: 'conversation:transition-integrity',
      agentId: 'agency-developer',
      trustDomain: 'agency',
      title: null,
      createdAt
    });
    const laterAt = '2026-07-21T12:01:00.000Z';

    expect(() =>
      context.sqlite
        .prepare('UPDATE agent_conversations SET version = 2, updated_at = ? WHERE id = ?')
        .run(laterAt, conversation.id)
    ).toThrow(/requires a matching message/iu);
    expect(() =>
      context.sqlite
        .prepare(
          `
          INSERT INTO agent_messages
            (id, conversation_id, conversation_agent_id, trust_domain, sequence,
             author_kind, responding_agent_id, response_mode, message_text,
             evidence_refs_json, created_at)
          VALUES ('message:wrong-sequence', ?, 'agency-developer', 'agency', 2,
                  'operator', NULL, 'operator_input', 'Wrong sequence', '[]', ?)
        `
        )
        .run(conversation.id, laterAt)
    ).toThrow(/canonical contract/iu);
  });

  it('atomically advances the exact conversation for a canonical raw-SQL message insert', async () => {
    const conversation = await new AgentConversationRepository(context.db).createConversation({
      id: 'conversation:raw-atomic-append',
      agentId: 'agency-developer',
      trustDomain: 'agency',
      title: null,
      createdAt
    });
    const laterAt = '2026-07-21T12:01:00.000Z';

    context.sqlite
      .prepare(
        `
          INSERT INTO agent_messages
            (id, conversation_id, conversation_agent_id, trust_domain, sequence,
             author_kind, responding_agent_id, response_mode, message_text,
             evidence_refs_json, created_at)
          VALUES ('message:raw-atomic-append', ?, 'agency-developer', 'agency', 1,
                  'operator', NULL, 'operator_input', 'Atomic raw append', '[]', ?)
        `
      )
      .run(conversation.id, laterAt);

    expect(
      context.sqlite
        .prepare('SELECT version, updated_at FROM agent_conversations WHERE id = ?')
        .get(conversation.id)
    ).toEqual({ version: 2, updated_at: laterAt });
    expect(
      context.sqlite
        .prepare('SELECT sequence FROM agent_messages WHERE conversation_id = ?')
        .all(conversation.id)
    ).toEqual([{ sequence: 1 }]);
  });

  it('rolls back a raw-SQL message whose checkpoint cannot advance and remains rerun-safe', async () => {
    const migration = await readFile(
      join(projectRoot, 'src', 'db', 'migrations', '008_agent_conversation_integrity.sql'),
      'utf8'
    );
    context.sqlite.exec(migration);
    context.sqlite.exec(migration);

    const conversation = await new AgentConversationRepository(context.db).createConversation({
      id: 'conversation:raw-rollback',
      agentId: 'agency-developer',
      trustDomain: 'agency',
      title: null,
      createdAt
    });
    const insert = context.sqlite.prepare(`
      INSERT INTO agent_messages
        (id, conversation_id, conversation_agent_id, trust_domain, sequence,
         author_kind, responding_agent_id, response_mode, message_text,
         evidence_refs_json, created_at)
      VALUES (?, ?, 'agency-developer', 'agency', ?,
              'operator', NULL, 'operator_input', 'Raw checkpoint', '[]', ?)
    `);
    const laterAt = '2026-07-21T12:01:00.000Z';
    insert.run('message:raw-first', conversation.id, 1, laterAt);

    expect(() => insert.run('message:raw-backward-time', conversation.id, 2, createdAt)).toThrow();
    expect(() => insert.run('message:raw-stale-sequence', conversation.id, 1, laterAt)).toThrow(
      /canonical contract/iu
    );

    expect(
      context.sqlite
        .prepare('SELECT version, updated_at FROM agent_conversations WHERE id = ?')
        .get(conversation.id)
    ).toEqual({ version: 2, updated_at: laterAt });
    expect(
      context.sqlite
        .prepare('SELECT id FROM agent_messages WHERE conversation_id = ? ORDER BY sequence')
        .all(conversation.id)
    ).toEqual([{ id: 'message:raw-first' }]);
  });
});
