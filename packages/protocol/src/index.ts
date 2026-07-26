export const languages = ['javascript', 'python', 'cpp', 'java'] as const;
export type Language = (typeof languages)[number];

export type SerializableValue = string | number | boolean | null | SerializableValue[] | {
  [key: string]: SerializableValue;
};

export interface StackFrame {
  name: string;
  line: number;
  locals: Record<string, SerializableValue>;
}

export interface TraceEvent {
  id: number;
  line: number;
  column?: number;
  type: 'step' | 'breakpoint' | 'stdout' | 'stderr' | 'error' | 'complete';
  stack: StackFrame[];
  output?: string;
  message?: string;
  elapsedMs: number;
}

export interface RunRequest {
  language: Language;
  code: string;
  stdin?: string;
  breakpoints: number[];
}

export interface RunCreated {
  runId: string;
  eventsUrl: string;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'compile-error' | 'runtime-error' | 'timed-out' | 'cancelled';
