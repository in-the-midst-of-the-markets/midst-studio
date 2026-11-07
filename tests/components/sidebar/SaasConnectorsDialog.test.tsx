import "../../setup-dom";
import "../../helpers/mock-sonner";

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { SaasConnectorsDialog } from "@/components/sidebar/SaasConnectorsDialog";

describe("SaasConnectorsDialog", () => {
  test("lists HubSpot and Stripe and opens the chosen connection", () => {
    const onConnect = mock(() => {});
    const onClose = mock(() => {});
    const { getAllByRole, getByRole, getByText } = render(
      <SaasConnectorsDialog open onClose={onClose} onConnect={onConnect} />,
    );

    expect(getByRole("heading", { name: "SAAS Connectors" })).not.toBeNull();
    expect(getByText(/HubSpot API/)).not.toBeNull();
    expect(getByText(/read-only/)).not.toBeNull();
    const [hubspot, stripe] = getAllByRole("button", { name: "Connect" });
    fireEvent.click(hubspot);
    expect(onConnect).toHaveBeenCalledWith("hubspot");
    fireEvent.click(stripe);
    expect(onConnect).toHaveBeenCalledWith("stripe");
  });
});
