import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export interface FlowLogger {
  start(taskId: string): void;
  log(from: string, to: string, message: string): void;
  save(): Promise<string>;
}

export interface MermaidLoggerOptions {
  projectRoot?: string;
  diagramsRoot?: string;
}

interface Handoff {
  from: string;
  to: string;
  message: string;
}

type LoggerState = 'idle' | 'started' | 'saving' | 'saved';

const MAX_TASK_ID_LENGTH = 128;
const MAX_PARTICIPANT_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 512;
const MERMAID_RESERVED_PARTICIPANTS = new Set([
  'activate',
  'actor',
  'alt',
  'and',
  'autonumber',
  'box',
  'break',
  'create',
  'critical',
  'deactivate',
  'destroy',
  'else',
  'end',
  'link',
  'links',
  'loop',
  'note',
  'opt',
  'par',
  'participant',
  'rect'
]);

function sanitizeTaskId(taskId: string): string {
  const safe = taskId
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_TASK_ID_LENGTH)
    .replace(/[-_]+$/g, '');
  return safe.length > 0 ? safe : 'task';
}

function sanitizeParticipant(participant: string): string {
  let safe = participant
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_PARTICIPANT_LENGTH)
    .replace(/_+$/g, '');
  if (safe.length === 0) {
    return 'Participant';
  }
  if (/^[0-9]/.test(safe) || MERMAID_RESERVED_PARTICIPANTS.has(safe.toLowerCase())) {
    safe = `Participant_${safe}`.slice(0, MAX_PARTICIPANT_LENGTH);
  }
  return safe;
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    return isControl ? ' ' : character;
  }).join('');
}

function sanitizeMessage(message: string): string {
  const safe = replaceControlCharacters(message.normalize('NFKC'))
    .replace(/;/g, ',')
    .replace(/&/g, ' and ')
    .replace(/[`<>%{}]/g, '')
    .replace(/-{1,2}>{1,2}/g, ' to ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
    .trim();
  return /[\p{L}\p{N}]/u.test(safe) ? safe : 'message';
}

function renderDiagram(taskId: string, handoffs: Handoff[]): string {
  return [
    `# Flow ${taskId}`,
    '',
    '```mermaid',
    'sequenceDiagram',
    ...handoffs.map(({ from, to, message }) => `    ${from}->>${to}: ${message}`),
    '```',
    ''
  ].join('\n');
}

function assertContained(boundaryRoot: string, target: string): void {
  const relativeTarget = relative(boundaryRoot, target);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    resolve(boundaryRoot, relativeTarget) !== target
  ) {
    throw new Error('MermaidLogger path escapes its trusted boundary');
  }
}

async function assertNoSymlinkTraversal(boundaryRoot: string, target: string): Promise<void> {
  assertContained(boundaryRoot, target);
  const relativeTarget = relative(boundaryRoot, target);
  const paths = [
    boundaryRoot,
    ...relativeTarget
      .split(sep)
      .filter((component) => component.length > 0)
      .map((_, index, components) => join(boundaryRoot, ...components.slice(0, index + 1)))
  ];

  for (const path of paths) {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error('MermaidLogger diagram path cannot traverse a symlink');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }
}

export class MermaidLogger implements FlowLogger {
  readonly #boundaryRoot: string;
  readonly #diagramsRoot: string;
  readonly #handoffs: Handoff[] = [];
  #state: LoggerState = 'idle';
  #taskId: string | undefined;

  constructor(options: MermaidLoggerOptions = {}) {
    this.#diagramsRoot = resolve(
      options.diagramsRoot ?? join(options.projectRoot ?? process.cwd(), 'logs', 'diagrams')
    );
    this.#boundaryRoot = resolve(
      options.projectRoot ??
        (options.diagramsRoot === undefined ? process.cwd() : dirname(dirname(this.#diagramsRoot)))
    );
    assertContained(this.#boundaryRoot, this.#diagramsRoot);
  }

  start(taskId: string): void {
    if (this.#state !== 'idle') {
      throw new Error('MermaidLogger has already started a trace');
    }
    this.#taskId = sanitizeTaskId(taskId);
    this.#state = 'started';
  }

  log(from: string, to: string, message: string): void {
    if (this.#state === 'idle') {
      throw new Error('MermaidLogger.start() must be called before log()');
    }
    if (this.#state !== 'started') {
      throw new Error('MermaidLogger trace is already saved');
    }
    this.#handoffs.push({
      from: sanitizeParticipant(from),
      to: sanitizeParticipant(to),
      message: sanitizeMessage(message)
    });
  }

  async save(): Promise<string> {
    if (this.#state === 'idle' || this.#taskId === undefined) {
      throw new Error('MermaidLogger.start() must be called before save()');
    }
    if (this.#state === 'saving') {
      throw new Error('MermaidLogger.save() is already in progress');
    }
    if (this.#state === 'saved') {
      throw new Error('MermaidLogger trace is already saved');
    }

    const target = join(this.#diagramsRoot, `flow_${this.#taskId}.md`);
    const relativeTarget = relative(this.#diagramsRoot, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)) {
      throw new Error('MermaidLogger task path escapes the diagram directory');
    }
    const temporary = join(this.#diagramsRoot, `.${basename(target)}.${randomUUID()}.tmp`);
    const content = renderDiagram(this.#taskId, this.#handoffs);

    this.#state = 'saving';
    try {
      await assertNoSymlinkTraversal(this.#boundaryRoot, this.#diagramsRoot);
      await mkdir(this.#diagramsRoot, { recursive: true });
      await assertNoSymlinkTraversal(this.#boundaryRoot, this.#diagramsRoot);
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, target);
      this.#state = 'saved';
      return target;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      this.#state = 'started';
      throw error;
    }
  }
}
