import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { SaveQueryModal } from "@/components/SaveQueryModal";

describe("SaveQueryModal", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders dialog elements when open", () => {
    const { baseElement } = render(
      <SaveQueryModal isOpen onClose={mock(() => {})} onSave={mock(() => {})} defaultQuery="SELECT 1" />,
    );
    const body = within(baseElement);
    expect(body.queryAllByText("Save Query").length).toBeGreaterThan(0);
    expect(body.queryByPlaceholderText("e.g. Monthly Active Users")).not.toBeNull();
    expect(body.queryByPlaceholderText("monthly_active_users")).not.toBeNull();
    expect(body.queryByPlaceholderText("What does this query do?")).not.toBeNull();
  });

  test("shows query preview", () => {
    const { baseElement } = render(
      <SaveQueryModal isOpen onClose={mock(() => {})} onSave={mock(() => {})} defaultQuery="SELECT * FROM users" />,
    );
    expect(baseElement.textContent).toContain("SELECT * FROM users");
  });

  test("saves query with parsed tags and resets the form", async () => {
    const onClose = mock(() => {});
    const onSave = mock(() => {});
    const { baseElement } = render(<SaveQueryModal isOpen onClose={onClose} onSave={onSave} defaultQuery="SELECT 1" />);
    const body = within(baseElement);

    const nameInput = body.getByPlaceholderText("e.g. Monthly Active Users") as HTMLInputElement;
    const idInput = body.getByPlaceholderText("monthly_active_users") as HTMLInputElement;
    const descriptionInput = body.getByPlaceholderText("What does this query do?") as HTMLTextAreaElement;
    const tagsInput = body.getByPlaceholderText("reports, analytics, users") as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: "Monthly Active Users" } });
    fireEvent.change(idInput, { target: { value: "monthly_active_users" } });
    fireEvent.change(descriptionInput, { target: { value: "Counts active users per month" } });
    fireEvent.change(tagsInput, { target: { value: " reports , analytics ,, users " } });

    await act(async () => {
      fireEvent.click(body.getByRole("button", { name: "Save Query" }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      "Monthly Active Users",
      "Counts active users per month",
      ["reports", "analytics", "users"],
      "monthly_active_users",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(nameInput.value).toBe("");
    expect(idInput.value).toBe("");
    expect(descriptionInput.value).toBe("");
    expect(tagsInput.value).toBe("");
  });

  test("saves with empty tag list when tags input is blank", async () => {
    const onSave = mock(() => {});
    const { baseElement } = render(
      <SaveQueryModal isOpen onClose={mock(() => {})} onSave={onSave} defaultQuery="SELECT 1" />,
    );
    const body = within(baseElement);

    fireEvent.change(body.getByPlaceholderText("e.g. Monthly Active Users"), { target: { value: "Untagged" } });
    fireEvent.change(body.getByPlaceholderText("monthly_active_users"), { target: { value: "untagged" } });
    await act(async () => {
      fireEvent.click(body.getByRole("button", { name: "Save Query" }));
    });

    expect(onSave).toHaveBeenCalledWith("Untagged", "", [], "untagged");
  });

  test("disables the save button while the name is empty", () => {
    const onSave = mock(() => {});
    const { baseElement } = render(
      <SaveQueryModal isOpen onClose={mock(() => {})} onSave={onSave} defaultQuery="SELECT 1" />,
    );
    const body = within(baseElement);

    const saveButton = body.getByRole("button", { name: "Save Query" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(saveButton);
    expect(onSave).not.toHaveBeenCalled();
  });

  test("refuses an ID that is not a table name and keeps the dialog open", async () => {
    const onSave = mock(() => {});
    const onClose = mock(() => {});
    const { baseElement } = render(<SaveQueryModal isOpen onClose={onClose} onSave={onSave} defaultQuery="SELECT 1" />);
    const body = within(baseElement);

    fireEvent.change(body.getByPlaceholderText("e.g. Monthly Active Users"), {
      target: { value: "Monthly Active Users" },
    });
    fireEvent.change(body.getByPlaceholderText("monthly_active_users"), { target: { value: "monthly active" } });

    expect(baseElement.textContent).toContain("letters, numbers, and underscores");
    const saveButton = body.getByRole("button", { name: "Save Query" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("refuses an ID another saved query already uses", async () => {
    const onSave = mock(() => {});
    const { baseElement } = render(
      <SaveQueryModal
        isOpen
        onClose={mock(() => {})}
        onSave={onSave}
        defaultQuery="SELECT 1"
        takenTableIds={["Monthly_Active_Users"]}
      />,
    );
    const body = within(baseElement);
    fireEvent.change(body.getByPlaceholderText("e.g. Monthly Active Users"), { target: { value: "Another" } });
    fireEvent.change(body.getByPlaceholderText("monthly_active_users"), { target: { value: "monthly_active_users" } });
    expect(baseElement.textContent).toContain("already uses this ID");
    expect((body.getByRole("button", { name: "Save Query" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  test("stays open when saving is refused", async () => {
    const onSave = mock(() => false);
    const onClose = mock(() => {});
    const { baseElement } = render(<SaveQueryModal isOpen onClose={onClose} onSave={onSave} defaultQuery="SELECT 1" />);
    const body = within(baseElement);
    fireEvent.change(body.getByPlaceholderText("e.g. Monthly Active Users"), { target: { value: "Orders" } });
    fireEvent.change(body.getByPlaceholderText("monthly_active_users"), { target: { value: "orders" } });
    await act(async () => {
      fireEvent.click(body.getByRole("button", { name: "Save Query" }));
    });
    expect(onSave).toHaveBeenCalledWith("Orders", "", [], "orders");
    expect(onClose).not.toHaveBeenCalled();
  });
});
