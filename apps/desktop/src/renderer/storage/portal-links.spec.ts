import { describe, expect, it } from 'vitest';
import {
  absolutePortalUrl,
  dataRoomDetailPath,
  dataRoomsListPath,
  portalSurfaceFor,
  workspaceDetailPath,
  workspacesListPath,
} from './portal-links.js';

describe('portal surface selection', () => {
  it('targets the org console when the row carries an orgId', () => {
    expect(portalSurfaceFor('org-acme')).toBe('org');
  });

  it('targets the personal console for a personal row', () => {
    expect(portalSurfaceFor(null)).toBe('user');
    expect(portalSurfaceFor(undefined)).toBe('user');
  });
});

describe('portal list paths', () => {
  it('builds the user and org data-room list routes', () => {
    expect(dataRoomsListPath('user')).toBe('/user/data-rooms');
    expect(dataRoomsListPath('org')).toBe('/b2b/data-rooms');
  });

  it('builds the user and org cloud-workspace list routes', () => {
    expect(workspacesListPath('user')).toBe('/user/workspaces');
    expect(workspacesListPath('org')).toBe('/b2b/workspaces');
  });
});

describe('portal detail paths', () => {
  it('encodes the data-room id in the path', () => {
    expect(dataRoomDetailPath('dr-1', 'user')).toBe('/user/data-rooms/dr-1');
    expect(dataRoomDetailPath('dr/1', 'org')).toBe('/b2b/data-rooms/dr%2F1');
  });

  it('encodes the workspace id in the path', () => {
    expect(workspaceDetailPath('ws-1', 'user')).toBe('/user/workspaces/ws-1');
    expect(workspaceDetailPath('ws 1', 'org')).toBe('/b2b/workspaces/ws%201');
  });
});

describe('absolutePortalUrl', () => {
  it('joins the origin and the path without doubling slashes', () => {
    expect(absolutePortalUrl('https://portal.test', '/user/data-rooms')).toBe(
      'https://portal.test/user/data-rooms',
    );
    expect(absolutePortalUrl('https://portal.test/', '/user/data-rooms')).toBe(
      'https://portal.test/user/data-rooms',
    );
    expect(absolutePortalUrl('https://portal.test', 'user/data-rooms')).toBe(
      'https://portal.test/user/data-rooms',
    );
  });

  it('returns null when no portal origin is configured', () => {
    expect(absolutePortalUrl(null, '/user/data-rooms')).toBeNull();
    expect(absolutePortalUrl('', '/user/data-rooms')).toBeNull();
    expect(absolutePortalUrl('   ', '/user/data-rooms')).toBeNull();
  });
});
