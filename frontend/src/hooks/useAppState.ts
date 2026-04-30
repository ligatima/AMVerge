import React, { useReducer, useRef } from "react";
import { ClipItem, EpisodeEntry, EpisodeFolder } from "../types/domain";

export type AppState = {
  focusedClip: string | null;
  selectedClips: Set<string>;
  clips: ClipItem[];
  episodes: EpisodeEntry[];
  selectedEpisodeId: string | null;
  episodeFolders: EpisodeFolder[];
  openedEpisodeId: string | null;
  selectedFolderId: string | null;
  importedVideoPath: string | null;
  videoIsHEVC: boolean | null;
};

export type AppAction =
  | { type: "setFocusedClip"; value: string | null }
  | { type: "setSelectedClips"; value: Set<string> }
  | { type: "setClips"; value: ClipItem[] }
  | { type: "setEpisodes"; value: EpisodeEntry[] }
  | { type: "setSelectedEpisodeId"; value: string | null }
  | { type: "setEpisodeFolders"; value: EpisodeFolder[] }
  | { type: "setOpenedEpisodeId"; value: string | null }
  | { type: "setSelectedFolderId"; value: string | null }
  | { type: "setImportedVideoPath"; value: string | null }
  | { type: "setVideoIsHEVC"; value: boolean | null }
  // Streaming import actions — reducer has current state so no stale-closure risk
  | { type: "importEpisodeReady"; episode: EpisodeEntry; clips: ClipItem[] }
  | { type: "clipThumbnailReady"; clipId: string }
  | { type: "removeClip"; clipId: string; episodeId: string; mergingIntoClipId: string }
  | { type: "finalizeActiveEpisode"; episodeId: string };

const initialState: AppState = {
  focusedClip: null,
  selectedClips: new Set(),
  clips: [],
  episodes: [],
  selectedEpisodeId: null,
  episodeFolders: [],
  openedEpisodeId: null,
  selectedFolderId: null,
  importedVideoPath: null,
  videoIsHEVC: null,
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "setFocusedClip": return { ...state, focusedClip: action.value };
    case "setSelectedClips": return { ...state, selectedClips: action.value };
    case "setClips": return { ...state, clips: action.value };
    case "setEpisodes": return { ...state, episodes: action.value };
    case "setSelectedEpisodeId": return { ...state, selectedEpisodeId: action.value };
    case "setEpisodeFolders": return { ...state, episodeFolders: action.value };
    case "setOpenedEpisodeId": return { ...state, openedEpisodeId: action.value };
    case "setSelectedFolderId": return { ...state, selectedFolderId: action.value };
    case "setImportedVideoPath": return { ...state, importedVideoPath: action.value };
    case "setVideoIsHEVC": return { ...state, videoIsHEVC: action.value };

    case "importEpisodeReady":
      return {
        ...state,
        clips: action.clips,
        episodes: [action.episode, ...state.episodes],
        selectedEpisodeId: action.episode.id,
        openedEpisodeId: action.episode.id,
      };

    case "clipThumbnailReady":
      return {
        ...state,
        clips: state.clips.map(c =>
          c.id === action.clipId ? { ...c, thumbnailReady: true } : c
        ),
      };

    case "removeClip": {
      const removed = state.clips.find(c => c.id === action.clipId);
      const removedSrcs = removed ? (removed.mergedSrcs ?? [removed.src]) : [];
      const mergeInto = (c: ClipItem) =>
        c.id !== action.mergingIntoClipId ? c : {
          ...c,
          mergedSrcs: [...removedSrcs, ...(c.mergedSrcs ?? [c.src])],
        };
      return {
        ...state,
        clips: state.clips.filter(c => c.id !== action.clipId).map(mergeInto),
        episodes: state.episodes.map(ep =>
          ep.id !== action.episodeId ? ep : {
            ...ep,
            clips: ep.clips.filter(c => c.id !== action.clipId).map(mergeInto),
          }
        ),
      };
    }

    case "finalizeActiveEpisode": {
      const finalClips = state.clips.map(c => {
        const { thumbnailReady: _ignored, ...rest } = c;
        return rest as ClipItem;
      });
      return {
        ...state,
        clips: finalClips,
        episodes: state.episodes.map(ep =>
          ep.id === action.episodeId
            ? { ...ep, clips: finalClips }
            : ep
        ),
      };
    }

    default: return state;
  }
}

export default function useAppState() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  function makeReducerSetter<K extends keyof AppState>(
    type: AppAction["type"],
    key: K
  ) {
    return (value: React.SetStateAction<AppState[K]>) => {
      const resolved =
        typeof value === "function"
          ? (value as (prev: AppState[K]) => AppState[K])(stateRef.current[key])
          : value;
      dispatch({ type, value: resolved } as AppAction);
    };
  }

  return {
    state,
    dispatch,
    setFocusedClip: makeReducerSetter("setFocusedClip", "focusedClip"),
    setSelectedClips: makeReducerSetter("setSelectedClips", "selectedClips"),
    setClips: makeReducerSetter("setClips", "clips"),
    setEpisodes: makeReducerSetter("setEpisodes", "episodes"),
    setSelectedEpisodeId: makeReducerSetter("setSelectedEpisodeId", "selectedEpisodeId"),
    setEpisodeFolders: makeReducerSetter("setEpisodeFolders", "episodeFolders"),
    setOpenedEpisodeId: makeReducerSetter("setOpenedEpisodeId", "openedEpisodeId"),
    setSelectedFolderId: makeReducerSetter("setSelectedFolderId", "selectedFolderId"),
    setImportedVideoPath: makeReducerSetter("setImportedVideoPath", "importedVideoPath"),
    setVideoIsHEVC: makeReducerSetter("setVideoIsHEVC", "videoIsHEVC"),
    importEpisodeReady: (episode: EpisodeEntry, clips: ClipItem[]) =>
      dispatch({ type: "importEpisodeReady", episode, clips }),
    clipThumbnailReady: (clipId: string) =>
      dispatch({ type: "clipThumbnailReady", clipId }),
    removeClip: (clipId: string, episodeId: string, mergingIntoClipId: string) =>
      dispatch({ type: "removeClip", clipId, episodeId, mergingIntoClipId }),
    finalizeActiveEpisode: (episodeId: string) =>
      dispatch({ type: "finalizeActiveEpisode", episodeId }),
  };
}
