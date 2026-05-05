import type { State } from './state.js';

export interface UI {
  intro(title: string, subtitle?: string): void;
  step(id: string, title: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  note(label: string, content: string): void;
  outro(message: string): void;
  runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface Step {
  id: string;
  title: string;
  appliesTo?: ('solo' | 'collaborator-invite' | 'hobbyist')[];
  check(state: State): Promise<{ done: boolean; reason?: string }>;
  prepare?(state: State, ui: UI): Promise<Partial<State['data']>>;
  execute(state: State, ui: UI): Promise<{ data?: Partial<State['data']>; warning?: string }>;
  verify(state: State): Promise<{ ok: boolean; details?: string }>;
}
