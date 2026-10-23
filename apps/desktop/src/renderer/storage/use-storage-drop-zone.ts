/**
 * Hook: accept an OS file/folder drop on an element and hand back the dropped
 * paths.
 *
 * Electron 32+ removed the `file.path` augmentation, so the absolute path of
 * each dropped `File` must come from `webUtils.getPathForFile`, which only
 * exists in the renderer process — exposed here through the preload bridge
 * (`bridge.getPathForFile`). A dropped folder arrives as a `File` whose path is
 * the directory itself; the main process walks it.
 *
 * The hook only reports *paths*. It never reads bytes, so dropping hundreds of
 * files costs the renderer nothing until progress starts to come back.
 */

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { bridge } from '../bridge.js';

export type StorageDropZone = {
  /** True while a drag is hovering the element (for the overlay). */
  dragOver: boolean;
  handlers: {
    onDragEnter: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
};

/** Extract absolute paths from a `DataTransfer`, dropping anything unusable. */
export function pathsFromDataTransfer(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const items = dt.files ? Array.from(dt.files) : [];
  const paths: string[] = [];
  for (const file of items) {
    try {
      // `getPathForFile` throws for a synthetic File (no on-disk backing).
      const path = bridge.getPathForFile(file);
      if (path) paths.push(path);
    } catch {
      // Ignore entries that cannot be resolved to a real path.
    }
  }
  return paths;
}

export function useStorageDropZone(
  onPaths: (paths: string[]) => void | Promise<void>,
  options: { enabled?: boolean } = {},
): StorageDropZone {
  const enabled = options.enabled !== false;
  const [dragOver, setDragOver] = useState(false);
  // `dragenter`/`dragleave` fire for every child; count them so the overlay does
  // not flicker while the pointer crosses inner elements.
  const depth = useRef(0);

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragOver(true);
    },
    [enabled],
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      // Preventing default is what marks the element as a drop target.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (!dragOver) setDragOver(true);
    },
    [enabled, dragOver],
  );

  const onDragLeave = useCallback(
    () => {
      if (!enabled) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragOver(false);
    },
    [enabled],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!enabled) return;
      event.preventDefault();
      depth.current = 0;
      setDragOver(false);
      const paths = pathsFromDataTransfer(event.dataTransfer);
      if (paths.length) void onPaths(paths);
    },
    [enabled, onPaths],
  );

  return { dragOver, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}
