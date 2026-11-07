"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SAAS_CONNECTORS } from "@/lib/saas-connectors";
import type { DatabaseType } from "@/lib/types";

interface SaasConnectorsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Opens the connection dialog already set to this connector. */
  onConnect: (type: DatabaseType) => void;
}

/** The connector list opened by SAAS Connectors, under Search Marketplace. */
export function SaasConnectorsDialog({ open, onClose, onConnect }: SaasConnectorsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>SAAS Connectors</DialogTitle>
        </DialogHeader>
        <ul className="mt-2 space-y-2">
          {SAAS_CONNECTORS.map((connector) => (
            <li
              key={connector.type}
              className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{connector.label}</p>
                <p className="mt-1 text-xs leading-relaxed text-fg-muted">{connector.description}</p>
              </div>
              <Button type="button" size="sm" className="shrink-0" onClick={() => onConnect(connector.type)}>
                Connect
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
