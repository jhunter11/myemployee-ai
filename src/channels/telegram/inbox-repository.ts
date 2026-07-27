import type SQLite from 'better-sqlite3';

export interface TelegramInboxClaim {
  claimed: boolean;
  duplicate: boolean;
  pendingReplay: boolean;
}

interface InboxRow {
  update_digest: string;
  status: string;
}

export class SqliteTelegramInboxRepository {
  private readonly now: () => string;

  constructor(
    private readonly sqlite: SQLite.Database,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  claim(input: {
    updateId: number;
    updateDigest: string;
    identityDigest: string;
    redactedKind: string;
  }): Promise<TelegramInboxClaim> {
    return Promise.resolve().then(() => {
      return this.sqlite.transaction((): TelegramInboxClaim => {
        const existing = this.sqlite
          .prepare('SELECT update_digest, status FROM telegram_channel_inbox WHERE update_id = ?')
          .get(input.updateId) as InboxRow | undefined;
        if (existing) {
          if (existing.update_digest !== input.updateDigest) {
            throw new Error('Telegram update ID was reused with different bounded content');
          }
          if (existing.status === 'completed') {
            return { claimed: false, duplicate: true, pendingReplay: false };
          }
          return { claimed: true, duplicate: false, pendingReplay: true };
        }
        this.sqlite
          .prepare(
            `INSERT INTO telegram_channel_inbox (
               update_id, update_digest, identity_digest, redacted_kind,
               status, command_id, received_at, completed_at
             ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)`
          )
          .run(
            input.updateId,
            input.updateDigest,
            input.identityDigest,
            input.redactedKind,
            this.now()
          );
        return { claimed: true, duplicate: false, pendingReplay: false };
      })();
    });
  }

  complete(updateId: number, commandId: string | null): Promise<void> {
    return Promise.resolve().then(() => {
      this.sqlite.transaction(() => {
        const completedAt = this.now();
        const result = this.sqlite
          .prepare(
            `UPDATE telegram_channel_inbox
               SET status = 'completed', command_id = ?, completed_at = ?
             WHERE update_id = ? AND status = 'pending'`
          )
          .run(commandId, completedAt, updateId);
        const existing = this.sqlite
          .prepare('SELECT status FROM telegram_channel_inbox WHERE update_id = ?')
          .get(updateId) as { status: string } | undefined;
        if (result.changes === 0 && existing?.status !== 'completed') {
          throw new Error('Telegram inbox update was not claimed');
        }
        this.sqlite
          .prepare(
            `UPDATE telegram_channel_state
               SET update_cursor = MAX(update_cursor, ?), updated_at = ?
             WHERE singleton_id = 1`
          )
          .run(updateId, completedAt);
      })();
    });
  }

  cursor(): Promise<number> {
    return Promise.resolve().then(() => {
      const row = this.sqlite
        .prepare('SELECT update_cursor FROM telegram_channel_state WHERE singleton_id = 1')
        .get() as { update_cursor: number };
      return row.update_cursor;
    });
  }
}
