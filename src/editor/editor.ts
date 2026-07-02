// Editor shell (M1): loads the project, owns the session (autosave, undo),
// top bar with save state. Preview, timeline and inspector mount into the
// body in later milestones.

import "./editor.css";
import { escapeHtml } from "../core/format";
import { describeError, ipc } from "../core/ipc";
import { navigate } from "../core/nav";
import { ProjectSession, currentSession } from "../core/session";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

export async function mountEditor(
  root: HTMLElement,
  projectPath: string,
): Promise<{ dispose(): Promise<void> }> {
  let loaded;
  try {
    loaded = await ipc.loadProject(projectPath);
  } catch (e) {
    toast.error(describeError(e));
    navigate({ view: "home" });
    return { dispose: async () => {} };
  }

  const session = new ProjectSession(projectPath, loaded.project);
  currentSession.set(session);

  if (loaded.recovered) toast.info("Project restored from its automatic backup.");
  if (loaded.missing.length > 0) {
    toast.error(
      `${loaded.missing.length} media file(s) are missing on disk. Relinking arrives in a later update.`,
    );
  }

  root.innerHTML = `
    <div class="editor">
      <div class="editor__topbar">
        <button class="btn btn--ghost btn--icon" id="ed-home" title="Back to projects">${icon("chevronLeft")}</button>
        <div class="editor__name" id="ed-name">${escapeHtml(session.project.name)}</div>
        <div class="editor__savestate" id="ed-save">Saved</div>
        <div class="grow"></div>
        <button class="btn btn--primary" id="ed-export" disabled title="Export arrives in a later milestone">${icon("export")}Export</button>
      </div>
      <div class="editor__body">
        <div class="empty-state grow">
          ${icon("film", 32)}
          <div>${session.project.media.length} media file(s) in this project.</div>
          <div class="faint">Preview and timeline arrive in the next milestones — autosave is already active.</div>
        </div>
      </div>
    </div>
  `;

  const saveBadge = root.querySelector<HTMLElement>("#ed-save")!;
  const unsubSave = session.saveState.subscribe((s) => {
    saveBadge.classList.toggle("editor__savestate--error", s === "error");
    saveBadge.textContent =
      s === "saved" ? "Saved" : s === "saving" ? "Saving…" : s === "dirty" ? "Edited" : "Save failed";
  });

  root.querySelector("#ed-home")!.addEventListener("click", () => {
    navigate({ view: "home" });
  });

  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      void session.save();
    } else if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      session.undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      session.redo();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  return {
    async dispose() {
      window.removeEventListener("keydown", onKeyDown);
      unsubSave();
      currentSession.set(null);
      await session.dispose();
    },
  };
}
