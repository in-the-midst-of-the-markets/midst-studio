"use client";

import { AiAssist } from "@/components/ai-assist/AiAssist";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";

export default function AssistPage() {
  return (
    <WorkspaceOwnerGate>
      <AiAssist />
    </WorkspaceOwnerGate>
  );
}
