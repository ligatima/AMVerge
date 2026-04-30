import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ClipItem, EpisodeEntry } from "../types/domain"
import { fileNameFromPath, truncateFileName } from "../utils/episodeUtils";
import { GeneralSettings } from "../settings/generalSettings";

type ImportExportProps = {
  abortedRef: React.RefObject<boolean>;
  clips: ClipItem[];
  selectedClips: Set<string>;
  setFocusedClip: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedClips: React.Dispatch<React.SetStateAction<Set<string>>>;
  setVideoIsHEVC: React.Dispatch<React.SetStateAction<boolean | null>>;
  setImportedVideoPath: React.Dispatch<React.SetStateAction<string | null>>;
  setClips: React.Dispatch<React.SetStateAction<ClipItem[]>>;
  setEpisodes: React.Dispatch<React.SetStateAction<EpisodeEntry[]>>;
  setSelectedEpisodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setOpenedEpisodeId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedFolderId: string | null;
  EXPORT_DIR_STORAGE_KEY: string;
  exportDir: string | null;
  setExportDir: React.Dispatch<React.SetStateAction<string | null>>;
  setProgress: React.Dispatch<React.SetStateAction<number>>;
  setProgressMsg: React.Dispatch<React.SetStateAction<string>>;
  episodesPath: string | null;
  exportFormat: "mp4" | "mkv" | "mov" | "avi";
  onRPCUpdate?: (data: any) => void;
  generalSettings: GeneralSettings;
  importEpisodeReady: (episode: EpisodeEntry, clips: ClipItem[]) => void;
  clipThumbnailReady: (clipId: string) => void;
  removeClip: (clipId: string, episodeId: string, mergingIntoClipId: string) => void;
  finalizeActiveEpisode: (episodeId: string) => void;
};

export type BgProgress = { done: number; total: number };

export default function useImportExport(props: ImportExportProps) {
  const [loading, setLoading] = useState(false);
  const [importToken, setImportToken] = useState(() => Date.now().toString());
  const importGenRef = useRef(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchDone, setBatchDone] = useState(0);
  const [batchCurrentFile, setBatchCurrentFile] = useState("");
  const [bgProgress, setBgProgress] = useState<BgProgress | null>(null);

  // Refs for streaming scene detection state (reset on each import).
  const positionToIdRef = useRef(new Map<number, string>());
  const thumbnailReadySetRef = useRef(new Set<string>());
  const gapClipsRef = useRef(new Set<string>());
  const prevSelectedClipsRef = useRef(new Set<string>());

  // Track newly selected clips against thumbnail readiness (for gap detection).
  useEffect(() => {
    const prev = prevSelectedClipsRef.current;
    for (const id of props.selectedClips) {
      if (!prev.has(id) && !thumbnailReadySetRef.current.has(id)) {
        gapClipsRef.current.add(id);
      }
    }
    prevSelectedClipsRef.current = new Set(props.selectedClips);
  }, [props.selectedClips]);

  // ── Streaming helpers ────────────────────────────────────────────────────────

  function resetStreamingRefs() {
    positionToIdRef.current = new Map();
    thumbnailReadySetRef.current = new Set();
    gapClipsRef.current = new Set();
    prevSelectedClipsRef.current = new Set();
  }

  function parseInitialClips(clipsJson: string): ClipItem[] {
    const scenes: any[] = JSON.parse(clipsJson);
    return scenes.map((s, pos) => {
      const id = crypto.randomUUID();
      positionToIdRef.current.set(pos, id);
      const ready = s.thumbnail_ready !== false;
      if (ready) thumbnailReadySetRef.current.add(id);
      return {
        id,
        src: s.path,
        thumbnail: s.thumbnail,
        originalName: s.original_file,
        thumbnailReady: ready,
      };
    });
  }

  /** Strip transient processing fields before persisting to episode state. */
  function finalizeClips(clips: ClipItem[]): ClipItem[] {
    return clips.map(({ thumbnailReady: _tr, ...rest }) => rest as ClipItem);
  }

  // ── Single import ────────────────────────────────────────────────────────────

  const handleImport = async (file: string | null) => {
    if (!file) return;

    const episodeId = crypto.randomUUID();
    const gen = ++importGenRef.current;

    resetStreamingRefs();

    props.setProgress(0);
    props.setProgressMsg("Starting...");
    setLoading(true);
    props.setSelectedClips(new Set());
    props.setFocusedClip(null);
    props.setImportedVideoPath(file);
    props.setVideoIsHEVC(null);
    setImportToken(Date.now().toString());

    const rpcButtons = [];
    if (props.generalSettings.rpcShowButtons) {
      rpcButtons.push({ label: "Discord Server", url: "https://discord.gg/asJkqwqb" });
      rpcButtons.push({ label: "Website", url: "https://amverge.app/" });
    }

    props.onRPCUpdate?.({
      type: "update",
      details: `Detecting: ${props.generalSettings.rpcShowFilename ? fileNameFromPath(file) : "Video"}`,
      state: "Processing Video",
      large_image: "amverge_logo",
      small_image: props.generalSettings.rpcShowMiniIcons ? "loading_icon_new" : undefined,
      small_text: props.generalSettings.rpcShowMiniIcons ? "Detecting..." : undefined,
      buttons: props.generalSettings.rpcShowButtons,
    });

    const unlisteners: Array<() => void> = [];
    let uiUnblocked = false;
    // Track the episodeId of the episode we are building so we can update it incrementally.
    const activeEpisodeId = episodeId;

    try {
      // ── initial_clips_ready: first N thumbnails ready, unblock UI ──────────
      const ul1 = await listen<{ clips_json: string }>("initial_clips_ready", (event) => {
        if (importGenRef.current !== gen) return;

        const clips = parseInitialClips(event.payload.clips_json);
        const inferredName = clips[0]?.originalName || fileNameFromPath(file);

        const episodeEntry: EpisodeEntry = {
          id: activeEpisodeId,
          displayName: inferredName,
          videoPath: file,
          folderId: props.selectedFolderId,
          importedAt: Date.now(),
          clips: finalizeClips(clips),
        };

        props.importEpisodeReady(episodeEntry, clips);

        if (!uiUnblocked) {
          uiUnblocked = true;
          setLoading(false);
        }

        const notReady = clips.filter(c => c.thumbnailReady === false).length;
        if (notReady > 0) {
          setBgProgress({ done: clips.length - notReady, total: clips.length });
        }
      });
      unlisteners.push(ul1);

      // ── thumbnail_ready: one more clip's thumbnail is on disk ───────────────
      const ul2 = await listen<{ position: number }>("thumbnail_ready", (event) => {
        if (importGenRef.current !== gen) return;

        const clipId = positionToIdRef.current.get(event.payload.position);
        if (!clipId) return;

        thumbnailReadySetRef.current.add(clipId);
        props.clipThumbnailReady(clipId);

        setBgProgress((prev) =>
          prev ? { ...prev, done: Math.min(prev.done + 1, prev.total) } : null
        );
      });
      unlisteners.push(ul2);

      // ── pair_result: merge decision for two adjacent clips ──────────────────
      const ul3 = await listen<{ pos_a: number; pos_b: number; should_merge: boolean }>(
        "pair_result",
        (event) => {
          if (importGenRef.current !== gen) return;
          if (!event.payload.should_merge) return;

          const clipAId = positionToIdRef.current.get(event.payload.pos_a);
          const clipBId = positionToIdRef.current.get(event.payload.pos_b);
          if (!clipAId || !clipBId) return;

          // Respect gaps: selected-while-placeholder clips break the merge chain.
          if (gapClipsRef.current.has(clipAId) || gapClipsRef.current.has(clipBId)) return;

          props.removeClip(clipAId, activeEpisodeId, clipBId);
        }
      );
      unlisteners.push(ul3);

      // ── processing_complete: all thumbnails and pairs done ──────────────────
      const ul4 = await listen<void>("processing_complete", (_event) => {
        if (importGenRef.current !== gen) return;

        setBgProgress(null);
        props.finalizeActiveEpisode(activeEpisodeId);
      });
      unlisteners.push(ul4);

      // Fire the backend; blocks until the sidecar exits.
      await invoke("detect_scenes", {
        videoPath: file,
        episodeCacheId: episodeId,
        customPath: props.episodesPath,
      });
    } catch (err) {
      if (importGenRef.current !== gen) return;
      console.error("Detection failed:", err);
      setBgProgress(null);
    } finally {
      unlisteners.forEach((ul) => ul());
      if (importGenRef.current === gen) {
        if (!uiUnblocked) setLoading(false);
      }
    }
  };

  // ── Batch import ─────────────────────────────────────────────────────────────

  const handleBatchImport = async (files: string[]) => {
    const gen = ++importGenRef.current;
    props.abortedRef.current = false;

    const completedEpisodes: EpisodeEntry[] = [];

    try {
      props.setProgress(0);
      props.setProgressMsg("Starting...");
      setLoading(true);
      props.setSelectedClips(new Set());
      props.setFocusedClip(null);
      props.setVideoIsHEVC(null);
      setBatchTotal(files.length);
      setBatchDone(0);
      setBatchCurrentFile("");

      for (let i = 0; i < files.length; i++) {
        if (props.abortedRef.current) break;
        if (importGenRef.current !== gen) return;

        const file = files[i];
        const episodeId = crypto.randomUUID();
        const fileName = fileNameFromPath(file);

        setBatchDone(i);
        setBatchCurrentFile(truncateFileName(fileName));
        props.setProgress(0);
        props.setProgressMsg("Starting...");

        resetStreamingRefs();

        // Build clips from streaming events during this file's processing.
        let batchClips: ClipItem[] = [];
        const unlisteners: Array<() => void> = [];

        try {
          const ul1 = await listen<{ clips_json: string }>("initial_clips_ready", (event) => {
            if (importGenRef.current !== gen) return;
            batchClips = parseInitialClips(event.payload.clips_json);
          });
          unlisteners.push(ul1);

          const ul2 = await listen<{ position: number }>("thumbnail_ready", (event) => {
            if (importGenRef.current !== gen) return;
            const clipId = positionToIdRef.current.get(event.payload.position);
            if (!clipId) return;
            thumbnailReadySetRef.current.add(clipId);
            batchClips = batchClips.map((c) =>
              c.id === clipId ? { ...c, thumbnailReady: true } : c
            );
          });
          unlisteners.push(ul2);

          const ul3 = await listen<{ pos_a: number; pos_b: number; should_merge: boolean }>(
            "pair_result",
            (event) => {
              if (importGenRef.current !== gen) return;
              if (!event.payload.should_merge) return;
              const clipAId = positionToIdRef.current.get(event.payload.pos_a);
              const clipBId = positionToIdRef.current.get(event.payload.pos_b);
              if (!clipAId || !clipBId) return;
              if (gapClipsRef.current.has(clipAId) || gapClipsRef.current.has(clipBId)) return;
              const removed = batchClips.find(c => c.id === clipAId);
              const removedSrcs = removed ? (removed.mergedSrcs ?? [removed.src]) : [];
              batchClips = batchClips
                .filter(c => c.id !== clipAId)
                .map(c => c.id !== clipBId ? c : {
                  ...c,
                  mergedSrcs: [...removedSrcs, ...(c.mergedSrcs ?? [c.src])],
                });
            }
          );
          unlisteners.push(ul3);

          await invoke("detect_scenes", {
            videoPath: file,
            episodeCacheId: episodeId,
            customPath: props.episodesPath,
          });

          if (props.abortedRef.current || importGenRef.current !== gen) {
            invoke("delete_episode_cache", {
              episodeCacheId: episodeId,
              customPath: props.episodesPath,
            }).catch(() => {});
            break;
          }

          const finalClips = finalizeClips(batchClips);
          const inferredName = finalClips[0]?.originalName || fileNameFromPath(file);

          const episodeEntry: EpisodeEntry = {
            id: episodeId,
            displayName: inferredName,
            videoPath: file,
            folderId: props.selectedFolderId,
            importedAt: Date.now(),
            clips: finalClips,
          };

          completedEpisodes.push(episodeEntry);
          props.setEpisodes((prev) => [episodeEntry, ...prev]);
        } catch (err) {
          if (props.abortedRef.current) {
            invoke("delete_episode_cache", {
              episodeCacheId: episodeId,
              customPath: props.episodesPath,
            }).catch(() => {});
            break;
          }
          console.error(`Detection failed for ${fileName}:`, err);
          invoke("delete_episode_cache", {
            episodeCacheId: episodeId,
            customPath: props.episodesPath,
          }).catch(() => {});
        } finally {
          unlisteners.forEach((ul) => ul());
        }
      }

      // Open the first completed episode.
      if (completedEpisodes.length > 0 && importGenRef.current === gen) {
        const first = completedEpisodes[0];
        props.setSelectedEpisodeId(first.id);
        props.setOpenedEpisodeId(first.id);
        props.setImportedVideoPath(first.videoPath);
        setImportToken(Date.now().toString());
        props.setClips(first.clips);
      }
    } finally {
      if (importGenRef.current === gen) {
        setLoading(false);
        setBatchTotal(0);
        setBatchDone(0);
        setBatchCurrentFile("");
      }
    }
  };

  // ── Dialog handlers ──────────────────────────────────────────────────────────

  const onImportClick = async () => {
    const files = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "avi"] }],
    });

    if (!files) return;
    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) return;

    if (fileList.length === 1) {
      handleImport(fileList[0]);
    } else {
      handleBatchImport(fileList);
    }
  };

  const handleExport = async (selectedClips: Set<string>, mergeEnabled: boolean, mergeFileName?: string) => {
    if (selectedClips.size === 0) return;

    const selected = props.clips.filter((c: ClipItem) => selectedClips.has(c.id));
    if (selected.length === 0) return;

    let dir = props.exportDir;
    if (!dir) {
      const picked = await open({ directory: true, multiple: false });
      if (!picked) return;
      dir = picked as string;
      props.setExportDir(dir);
    }

    try {
      setLoading(true);

      const sep = dir.includes("\\") ? "\\" : "/";
      const clipArray = selected.flatMap((c: ClipItem) => c.mergedSrcs ?? [c.src]);
      const format = props.exportFormat || "mp4";

      props.onRPCUpdate?.({
        type: "update",
        details: `Exporting ${selected.length} clips`,
        state: "Saving Progress",
        large_image: "amverge_logo",
        small_image: props.generalSettings.rpcShowMiniIcons ? "save_icon_new" : undefined,
        small_text: props.generalSettings.rpcShowMiniIcons ? "Exporting..." : undefined,
        buttons: props.generalSettings.rpcShowButtons,
      });

      if (mergeEnabled) {
        const baseName = mergeFileName || ((selected[0]?.originalName || "episode") + "_merged");
        const savePath = `${dir}${sep}${baseName}.${format}`;
        await invoke("export_clips", { clips: clipArray, savePath, mergeEnabled });
      } else {
        const firstClipPath = selected[0]?.src || "";
        const firstFile = firstClipPath.split(/[/\\]/).pop() || `episode_0000.${format}`;
        const firstStem = firstFile.replace(/\.[^/.]+$/, "");
        const defaultBase = firstStem.replace(/_\d{4}$/, "");
        const savePath = `${dir}${sep}${defaultBase}_####.${format}`;
        await invoke("export_clips", { clips: clipArray, savePath, mergeEnabled: false });
      }

      props.onRPCUpdate?.({
        type: "update",
        details: "Export Finished!",
        state: "Success",
        large_image: "amverge_logo",
        small_image: props.generalSettings.rpcShowMiniIcons ? "check_icon_new" : undefined,
        small_text: props.generalSettings.rpcShowMiniIcons ? "Done" : undefined,
        buttons: props.generalSettings.rpcShowButtons,
      });

      setTimeout(() => {
        props.onRPCUpdate?.({
          type: "update",
          details: "Editing Episode",
          state: "Ready",
          large_image: "amverge_logo",
          small_image: props.generalSettings.rpcShowMiniIcons ? "edit_icon_new" : undefined,
          small_text: props.generalSettings.rpcShowMiniIcons ? "Editing" : undefined,
          buttons: props.generalSettings.rpcShowButtons,
        });
      }, 10000);
    } catch (err) {
      console.log("Export failed:", err);
    } finally {
      setLoading(false);
    }
  };

  const handlePickExportDir = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (dir) props.setExportDir(dir as string);
  };

  const handleDownloadSingleClip = async (clip: ClipItem) => {
    try {
      const format = props.exportFormat || "mp4";
      const fileName = clip.originalName || fileNameFromPath(clip.src);
      const defaultPath = `${fileName}.${format}`;

      const savePath = await save({
        defaultPath,
        filters: [{ name: "Video", extensions: [format] }],
      });

      if (!savePath) return;

      setLoading(true);
      const srcs = clip.mergedSrcs ?? [clip.src];
      await invoke("export_clips", { clips: srcs, savePath, mergeEnabled: srcs.length > 1 });
    } catch (err) {
      console.error("Single clip download failed:", err);
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    importToken,
    setImportToken,
    batchTotal,
    batchDone,
    batchCurrentFile,
    bgProgress,
    onImportClick,
    handleImport,
    handleExport,
    handlePickExportDir,
    handleBatchImport,
    handleDownloadSingleClip,
  };
}
