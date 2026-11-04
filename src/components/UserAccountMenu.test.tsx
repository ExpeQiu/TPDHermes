import { afterEach, describe, expect, it, vi } from "vitest";

import { act, cleanupDom, clickElement, renderComponent, setInputValue } from "@/test-utils/component-test-utils";
import UserAccountMenu from "./UserAccountMenu";

const fetchLocalSession = vi.fn();
const loginLocalAccount = vi.fn();
const registerLocalAccount = vi.fn();
const logoutLocalAccount = vi.fn();
const reloadAfterAuth = vi.fn();
const loadLocalProfile = vi.fn();

vi.mock("@/lib/local-account", () => ({
  DEFAULT_INITIAL_PASSWORD: "geely123",
  fetchLocalSession: (...args: unknown[]) => fetchLocalSession(...args),
  loginLocalAccount: (...args: unknown[]) => loginLocalAccount(...args),
  registerLocalAccount: (...args: unknown[]) => registerLocalAccount(...args),
  logoutLocalAccount: (...args: unknown[]) => logoutLocalAccount(...args),
  reloadAfterAuth: (...args: unknown[]) => reloadAfterAuth(...args),
  loadLocalProfile: (...args: unknown[]) => loadLocalProfile(...args),
}));

describe("UserAccountMenu", () => {
  afterEach(() => {
    cleanupDom();
    fetchLocalSession.mockReset();
    loginLocalAccount.mockReset();
    registerLocalAccount.mockReset();
    logoutLocalAccount.mockReset();
    reloadAfterAuth.mockReset();
    loadLocalProfile.mockReset();
  });

  it("未登录时打开圆形入口，可切换注册并提交", async () => {
    loadLocalProfile.mockReturnValue(null);
    fetchLocalSession.mockResolvedValue(null);
    registerLocalAccount.mockResolvedValue({
      user_id: "user_1",
      username: "ada",
      display_name: "ada",
      employee_id: "10086",
      org_id: "org1",
      avatar_initial: "A",
    });

    const { container } = renderComponent(<UserAccountMenu />);
    await act(async () => {
      await Promise.resolve();
    });

    clickElement(container.querySelector("button[aria-label='用户']")!);
    expect(container.textContent).toContain("登录");
    clickElement(Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "注册")!);
    expect(container.textContent).toContain("工号");
    expect(container.textContent).toContain("组织");

    const inputs = Array.from(container.querySelectorAll("input"));
    setInputValue(inputs[0] as HTMLInputElement, "ada");
    setInputValue(inputs[1] as HTMLInputElement, "10086");
    setInputValue(inputs[2] as HTMLInputElement, "org1");
    setInputValue(inputs[3] as HTMLInputElement, "geely123");
    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(registerLocalAccount).toHaveBeenCalledWith({
      username: "ada",
      employee_id: "10086",
      org_id: "org1",
      password: "geely123",
    });
    expect(reloadAfterAuth).toHaveBeenCalled();
  });

  it("已登录时展示用户信息并退出", async () => {
    loadLocalProfile.mockReturnValue({
      user_id: "user_1",
      username: "ada",
      display_name: "ada",
      employee_id: "10086",
      org_id: "org1",
      platform_role_label: "项目成员",
      avatar_initial: "A",
    });
    fetchLocalSession.mockResolvedValue({
      user_id: "user_1",
      username: "ada",
      display_name: "ada",
      employee_id: "10086",
      org_id: "org1",
      platform_role_label: "项目成员",
      avatar_initial: "A",
    });
    logoutLocalAccount.mockResolvedValue(undefined);

    const { container } = renderComponent(<UserAccountMenu />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("button[aria-label='用户']")?.textContent).toContain("A");
    clickElement(container.querySelector("button[aria-label='用户']")!);
    expect(container.textContent).toContain("10086");
    expect(container.textContent).toContain("org1");
    clickElement(Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "退出")!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(logoutLocalAccount).toHaveBeenCalled();
    expect(reloadAfterAuth).toHaveBeenCalled();
  });
});
