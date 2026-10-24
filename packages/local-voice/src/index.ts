/**
 * `@nexus/local-voice` — desktop-local STT/TTS model management for the ANX
 * desktop app.
 *
 * The desktop needs speech models that run on the user's own machine (Whisper,
 * a local TTS, or a self-hosted OpenAI-compatible server). This package provides
 * the pure, Electron-free bones of that subsystem — hardware probing, region
 * catalog normalization, download planning, protocol/endpoint resolution, and
 * the idle auto-unload lifecycle — so the main process and the settings UI share
 * one behavior. The side-effecting parts (spawning processes, streaming files to
 * disk, HTTP requests) live in the main process and are injected here.
 */

export * from './protocol.js';
export * from './catalog.js';
export * from './builtin-catalog.js';
export * from './resources.js';
export * from './archive.js';
export * from './binary-catalog.js';
export * from './binary-plan.js';
export * from './gpu-engine.js';
export * from './download.js';
export * from './downloader.js';
export * from './lifecycle.js';
export * from './settings.js';
