import { describe, expect, it } from "vitest";

import { parseCoCreateNewCommand } from "./co-create-slash-commands";

describe("parseCoCreateNewCommand", () => {
  it("识别 /new 指令", () => {
    expect(parseCoCreateNewCommand("/new")).toEqual({});
    expect(parseCoCreateNewCommand("/NEW")).toEqual({});
    expect(parseCoCreateNewCommand("/new  方案讨论")).toEqual({ title: "方案讨论" });
  });

  it("非 /new 指令返回 null", () => {
    expect(parseCoCreateNewCommand("hello")).toBeNull();
    expect(parseCoCreateNewCommand("/生成新文件")).toBeNull();
    expect(parseCoCreateNewCommand("/newbie")).toBeNull();
  });
});
