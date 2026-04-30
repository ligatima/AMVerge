export type ClipItem = {
  id: string;
  src: string;
  thumbnail: string;
  originalName?: string;
  thumbnailReady?: boolean; // false = actively generating; undefined/true = ready
  mergedSrcs?: string[];   // all source files this clip represents (set when clips are merged)
};

export type EpisodeFolder = {
  id: string;
  name: string;
  parentId: string | null;
  isExpanded: boolean;
};

export type EpisodeEntry = {
  id: string;
  displayName: string;
  videoPath: string;
  folderId: string | null;
  importedAt: number;
  clips: ClipItem[];
};