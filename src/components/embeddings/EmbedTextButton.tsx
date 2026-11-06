"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { EmbeddingModelSelect } from "@/components/embeddings/EmbeddingModelSelect";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createEmbeddingId } from "@/lib/embeddings/ids";

/**
 * The IDE control beside Lines, on a database that searches by a vector.
 *
 * A click asks for the text. The id it returns is what goes in the WHERE clause.
 * The vector is made when the query runs, not when the id is created.
 */
export function EmbedTextButton({ connectionId }: { readonly connectionId?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const connected = (connectionId?.trim() ?? "") !== "";

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-2"
        disabled={!connected}
        title={connected ? "Embed text and get an id for the WHERE clause" : "Connect a database to embed text"}
        onClick={() => {
          setText("");
          setError(null);
          setToken(null);
          setOpen(true);
        }}
      >
        Embed
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Embed text</DialogTitle>
            <DialogDescription>
              Put the id in the WHERE clause. It becomes a vector when the query runs.
            </DialogDescription>
          </DialogHeader>
          <label className="block text-xs text-fg-muted">
            Text
            <textarea
              aria-label="Text to embed"
              value={text}
              rows={3}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
              className="mt-1.5 w-full resize-y rounded border border-hairline bg-canvas px-2 py-1.5 text-xs text-fg"
            />
          </label>
          <EmbeddingModelSelect connectionId={connectionId} />
          {error !== null && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            className="h-7 w-fit text-xs"
            onClick={() => {
              const created = createEmbeddingId(connectionId, text);
              if (!created.ok) {
                setToken(null);
                setError(created.error);
                return;
              }
              setError(null);
              setToken(created.token);
            }}
          >
            Create id
          </Button>
          {token !== null && (
            <div className="flex items-center gap-2">
              <input
                aria-label="Embed id"
                readOnly
                value={token}
                className="h-7 min-w-0 flex-1 rounded border border-hairline bg-canvas px-2 font-mono text-xs text-fg"
              />
              <CopyButton text={token} testId="embed-id-copy" label="Copy id" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
