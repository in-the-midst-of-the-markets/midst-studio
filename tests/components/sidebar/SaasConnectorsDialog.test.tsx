import "../../setup-dom";
import "../../helpers/mock-sonner";

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { SaasConnectorsDialog } from "@/components/sidebar/SaasConnectorsDialog";

describe("SaasConnectorsDialog", () => {
  test("lists HubSpot and opens that connection", () => {
    const onConnect = mock(() => {});
    const onClose = mock(() => {});
    const { getByRole, getByText } = render(<SaasConnectorsDialog open onClose={onClose} onConnect={onConnect} />);

    expect(getByRole("heading", { name: "SAAS Connectors" })).not.toBeNull();
    expect(getByText(/HubSpot API/)).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith("hubspot");
  });
});
