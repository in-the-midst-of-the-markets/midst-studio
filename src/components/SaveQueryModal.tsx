"use client";

import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Bookmark, Tag } from "lucide-react";
import { savedQueryTableIdError } from "@/lib/saved-query-id";

interface SaveQueryModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Persist the query. Return `false` to keep the dialog open, for a refusal the caller
   * has already explained.
   */
  onSave: (
    name: string,
    description: string,
    tags: string[],
    tableId: string,
  ) => void | boolean | Promise<void | boolean>;
  defaultQuery: string;
  /** IDs already used by other saved queries, compared without regard to case. */
  takenTableIds?: readonly string[];
}

export function SaveQueryModal({ isOpen, onClose, onSave, defaultQuery, takenTableIds }: SaveQueryModalProps) {
  const [name, setName] = useState("");
  const [tableId, setTableId] = useState("");
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  const idError = tableId === "" ? null : savedQueryTableIdError(tableId);
  const idTaken =
    idError === null &&
    tableId !== "" &&
    (takenTableIds ?? []).some((taken) => taken.toLowerCase() === tableId.toLowerCase());
  const idProblem = idError ?? (idTaken ? "Another saved query already uses this ID." : null);

  const handleSave = async () => {
    if (!name || savedQueryTableIdError(tableId) !== null || idTaken) return;
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t);
    const saved = await Promise.resolve(onSave(name, description, tags, tableId));
    if (saved === false) return;
    setName("");
    setTableId("");
    setDescription("");
    setTagsInput("");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-raised border-hairline-strong text-fg-secondary sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="text-fg flex items-center gap-2">
            <Bookmark strokeWidth={1.5} className="w-5 h-5 text-brand" /> Save Query
          </DialogTitle>
          <DialogDescription className="text-fg-muted">
            Give your query a name and description to find it easily later.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="name" className="text-xs font-medium text-fg-muted">
              Name
            </Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Monthly Active Users"
              className="bg-fill border-hairline-strong focus:ring-brand-tint/20"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="query-id" className="text-xs font-medium text-fg-muted">
              ID
            </Label>
            <Input
              id="query-id"
              value={tableId}
              onChange={(e) => setTableId(e.target.value)}
              placeholder="monthly_active_users"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={idProblem !== null}
              aria-describedby="query-id-hint"
              className="bg-fill border-hairline-strong font-mono focus:ring-brand-tint/20"
            />
            <p id="query-id-hint" className={idProblem ? "text-xs text-danger" : "text-xs text-fg-muted"}>
              {idProblem ??
                (tableId === ""
                  ? "Letters, numbers, and underscores. A join uses it as saved.<id>."
                  : `Use it in a join as saved.${tableId}.`)}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description" className="text-xs font-medium text-fg-muted">
              Description
            </Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this query do?"
              className="bg-fill border-hairline-strong focus:ring-brand-tint/20 min-h-[80px]"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tags" className="text-xs font-medium text-fg-muted flex items-center gap-2">
              <Tag strokeWidth={1.5} className="w-3 h-3" /> Tags (comma separated)
            </Label>
            <Input
              id="tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="reports, analytics, users"
              className="bg-fill border-hairline-strong focus:ring-brand-tint/20"
            />
          </div>
          <div className="mt-2">
            <Label className="text-xs font-medium text-fg-muted mb-2 block">Preview</Label>
            <div className="bg-canvas p-3 rounded-md border border-hairline max-h-[100px] overflow-y-auto">
              <pre className="text-xs font-mono text-fg-muted italic whitespace-pre-wrap break-words">
                {defaultQuery}
              </pre>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} className="text-fg-tertiary">
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!name || savedQueryTableIdError(tableId) !== null || idTaken}
            className="bg-brand-solid hover:bg-brand-solid-hover text-white font-medium"
          >
            Save Query
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
