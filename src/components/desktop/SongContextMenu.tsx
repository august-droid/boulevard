import React from 'react';
import type { Song } from '@/types';

// Native build of the song context-menu system.
//
// Right-click menus are a desktop-web feature. On iOS/Android these are inert
// pass-throughs; Metro picks the real implementation (SongContextMenu.web.tsx)
// only for web.

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function useSongContextMenu(): { openSongMenu: (song: Song, x: number, y: number) => void } {
  return { openSongMenu: () => {} };
}

export function RightClickable({ children }: { song: Song; children: React.ReactNode }) {
  return <>{children}</>;
}
