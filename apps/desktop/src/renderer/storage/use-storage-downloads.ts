/**
 * Renderer download/save orchestration.
 *
 * Three ways to get a file out of a bucket:
 * - **Save…** (per file): native save dialog + a streamed write in main.
 * - **Save N…** (multi-selection): native folder picker, then one streamed
 *   write per file with collision-safe names.
 * - **Drag out to the OS**: `webContents.startDrag` needs a *real file on disk*
 *   and must fire while the drag is live. We therefore pre-stage the temp copy
 *   on row hover (`prepareDrag`) so the `dragstart` handler only has to call
 *   `startDrag`, which is fast enough to land inside the same drag gesture.
 */

import { useCallback, useRef, useState } from 'react';
import { bridge } from '../bridge.js';

export type StorageFileRef = { id: string; name: string };

export type SaveOutcome = { saved: boolean; cancelled: boolean; error?: string | null };
export type SaveManyOutcome = { saved: number; cancelled: boolean; error?: string | null };

export type UseStorageDownloads = {
  /** Save one file via the native save dialog. */
  saveOne: (file: StorageFileRef) => Promise<SaveOutcome>;
  /** Save many files into a user-picked directory. */
  saveMany: (files: StorageFileRef[]) => Promise<SaveManyOutcome>;
  /** Pre-stage a temp copy so a subsequent drag-out is instant. */
  warmDrag: (file: StorageFileRef) => void;
  /** `dragstart` handler: begin the OS drag of an already-staged file. */
  onDragStart: (event: { dataTransfer: DataTransfer | null; preventDefault: () => void }, file: StorageFileRef) => void;
  /** `dragend` handler: clean up the staged temp copy. */
  onDragEnd: (file: StorageFileRef) => void;
  /** The file id currently being dragged out (for row styling). */
  draggingId: string | null;
};

export function useStorageDownloads(): UseStorageDownloads {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const warmInFlight = useRef(new Set<string>());

  const warmDrag = useCallback((file: StorageFileRef) => {
    if (warmInFlight.current.has(file.id)) return;
    warmInFlight.current.add(file.id);
    void bridge
      .storagePrepareDrag(file.id, file.name)
      .catch(() => undefined)
      .finally(() => warmInFlight.current.delete(file.id));
  }, []);

  const saveOne = useCallback(async (file: StorageFileRef): Promise<SaveOutcome> => {
    try {
      const result = await bridge.storageSaveFile(file.id, file.name);
      return { saved: result.saved, cancelled: result.cancelled, error: result.error ?? null };
    } catch (err) {
      return { saved: false, cancelled: false, error: err instanceof Error ? err.message : 'save failed' };
    }
  }, []);

  const saveMany = useCallback(
    async (files: StorageFileRef[]): Promise<SaveManyOutcome> => {
      if (!files.length) return { saved: 0, cancelled: false, error: null };
      try {
        const result = await bridge.storageSaveFilesToDir(
          files.map((f) => ({ fileId: f.id, name: f.name })),
        );
        return {
          saved: result.saved,
          cancelled: result.cancelled,
          error: null,
        };
      } catch (err) {
        return { saved: 0, cancelled: false, error: err instanceof Error ? err.message : 'save failed' };
      }
    },
    [],
  );

  const onDragStart = useCallback(
    (event: { dataTransfer: DataTransfer | null; preventDefault: () => void }, file: StorageFileRef) => {
      // CRITICAL: cancel the default HTML5 drag. Left alone, Chromium starts a
      // *text* drag from this `draggable` element, which the OS lands as a
      // generic `dropped text.txt` whose content is whatever string the drag
      // carried — exactly the reported "wrong name + filename-as-content" bug.
      // `preventDefault()` hands the gesture to `webContents.startDrag` in main,
      // which drags the real staged file instead. Do NOT set a text payload.
      event.preventDefault();
      setDraggingId(file.id);
      // Main stages on demand if the hover warm-up has not finished yet, then
      // starts the OS drag with the staged file.
      void bridge.storageStartDrag(file.id, file.name).catch(() => undefined);
    },
    [],
  );

  const onDragEnd = useCallback((file: StorageFileRef) => {
    setDraggingId((current) => (current === file.id ? null : current));
    void bridge.storageReleaseDrag(file.id).catch(() => undefined);
  }, []);

  return { saveOne, saveMany, warmDrag, onDragStart, onDragEnd, draggingId };
}
