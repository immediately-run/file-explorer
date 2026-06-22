import { useEffect, useRef, useState } from "react";
import { chat, uploadFile } from "@immediately-run/sdk";
import { readFile } from "../fs/mountFs";
import { dirOf, joinPath, toMountRel } from "../lib/explorer";
import "./SummaryModal.css";

/** The file to summarize, in the explorer's absolute-path space. */
export interface SummaryTarget {
  absPath: string;
  rootPath: string;
  name: string;
  /** Whether the source mount is writable (gates the "Save summary" affordance). */
  writable: boolean;
}

type Phase = "reading" | "streaming" | "done" | "error";

// Keep the prompt within a sane size; a real app would chunk/map-reduce.
const MAX_CHARS = 40_000;

/**
 * Summarize a file with the platform's provider-agnostic LLM and show the result in
 * a modal — the fork's headline feature. It calls `chat()` (the `llm.chat@1` slot,
 * needing only the `llm:chat` capability the fork was consented), streams the summary
 * in, and can save it next to the source file (gated on a writable mount).
 *
 * This is an in-iframe overlay (the fork draws its own dialog inside its sandbox).
 * The host-chrome `ui:overlay` self-overlay (SERVICE_PROVIDERS_SPEC §6.3) is the
 * richer follow-up.
 */
export default function SummaryModal({
  target,
  onClose,
}: {
  target: SummaryTarget;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("reading");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // run the stream once (StrictMode double-mount safe)
    startedRef.current = true;
    let live = true;
    void (async () => {
      try {
        const bytes = await readFile(target.absPath);
        let content = new TextDecoder().decode(bytes);
        if (content.length > MAX_CHARS) content = `${content.slice(0, MAX_CHARS)}\n…(truncated)`;
        if (!live) return;
        setPhase("streaming");
        const stream = chat({
          messages: [
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text: "You summarize files concisely. Write a short paragraph, then 3–5 bullet points of the key contents.",
                },
              ],
            },
            { role: "user", content: [{ type: "text", text: `Summarize ${target.name}:\n\n${content}` }] },
          ],
          maxTokens: 600,
        });
        let acc = "";
        for await (const d of stream) {
          if (!live) return;
          if (d.type === "text-delta") {
            acc += d.text;
            setText(acc);
          }
        }
        if (live) setPhase("done");
      } catch (e) {
        if (!live) return;
        const code = (e as { code?: string })?.code;
        setError(
          code === "auth-required"
            ? "No language-model provider is configured. Add an API key (Anthropic or OpenAI) in settings, then try again."
            : code === "forbidden"
              ? "This app isn't allowed to use the language model."
              : `Couldn't summarize: ${(e as Error)?.message ?? "unknown error"}.`,
        );
        setPhase("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [target]);

  const save = async () => {
    const saveAbs = joinPath(dirOf(target.absPath), `${target.name}.summary.md`);
    const rel = toMountRel(target.rootPath, saveAbs);
    try {
      await uploadFile(rel, new TextEncoder().encode(text));
      setSaved(rel);
    } catch (e) {
      setError(`Couldn't save: ${(e as Error)?.message ?? "read-only"}.`);
    }
  };

  return (
    <div
      className="sm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Summary of ${target.name}`}
      onClick={onClose}
    >
      <div className="sm-panel" onClick={(e) => e.stopPropagation()}>
        <header className="sm-head">
          <span className="sm-title grad-text">Summary</span>
          <code className="sm-file" title={target.absPath}>
            {target.name}
          </code>
        </header>
        <div className="sm-body">
          {phase === "reading" && <p className="sm-status">Reading file…</p>}
          {phase === "error" && <p className="sm-status sm-error">{error}</p>}
          {(phase === "streaming" || phase === "done") && (
            <div className="sm-text">
              {text}
              {phase === "streaming" && <span className="sm-caret">▍</span>}
            </div>
          )}
        </div>
        <footer className="sm-foot">
          {saved ? <span className="sm-saved">Saved {saved}.</span> : <span />}
          <div className="sm-actions">
            {target.writable && phase === "done" && !saved && (
              <button type="button" className="sm-btn" onClick={save}>
                Save summary
              </button>
            )}
            <button type="button" className="sm-btn sm-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
