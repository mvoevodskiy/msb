// Типы контракта для logic.d.ts: реэкспорт из src/shared/types.ts плюс производные, которых там нет отдельно.
// Только для проверки типов (tsc) — браузер этот файл не загружает.

export type {
  Snapshot, SnapshotResponse, Task, Run, Bot, Span, Subscription, Balance, Project, Service, ServerState, Level, Tab, RunStatus,
} from '../shared/types.ts';
import type { Task } from '../shared/types.ts';

/** Пропуск задачи (элемент Task.gaps). */
export type Gap = Task['gaps'][number];
