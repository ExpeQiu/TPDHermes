import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

type RenderHookOptions<TProps> = {
  initialProps: TProps;
};

type RenderHookResult<TResult, TProps> = {
  result: { current: TResult };
  rerender: (props: TProps) => void;
  unmount: () => void;
};

export { act };

export function renderHook<TResult>(callback: () => TResult): RenderHookResult<TResult, void>;
export function renderHook<TResult, TProps>(
  callback: (props: TProps) => TResult,
  options: RenderHookOptions<TProps>,
): RenderHookResult<TResult, TProps>;
export function renderHook<TResult, TProps>(
  callback: ((props: TProps) => TResult) | (() => TResult),
  options?: RenderHookOptions<TProps>,
): RenderHookResult<TResult, TProps | void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const result = {} as { current: TResult };
  let currentProps = options?.initialProps as TProps;

  function HookHarness(props: { hookProps: TProps }) {
    result.current = (callback as (hookProps: TProps) => TResult)(props.hookProps);
    return null;
  }

  const render = (props: TProps) => {
    act(() => {
      root.render(React.createElement(HookHarness, { hookProps: props }));
    });
  };

  render(currentProps);

  return {
    result,
    rerender: (props: TProps | void) => {
      currentProps = props as TProps;
      render(currentProps);
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export async function waitFor(assertion: () => void, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("waitFor timed out");
}
