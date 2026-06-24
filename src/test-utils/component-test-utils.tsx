import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

export { act };

type RenderResult = {
  container: HTMLDivElement;
  rerender: (element: ReactElement) => void;
  unmount: () => void;
};

export function renderComponent(element: ReactElement): RenderResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const render = (nextElement: ReactElement) => {
    act(() => {
      root.render(nextElement);
    });
  };

  render(element);

  return {
    container,
    rerender: render,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export function cleanupDom() {
  document.body.innerHTML = "";
}

export function findByText(container: HTMLElement, text: string): HTMLElement | null {
  const matcher = text.trim();
  const elements = Array.from(container.querySelectorAll<HTMLElement>("*"));
  return (
    elements.find((element) => {
      const ownText = element.textContent?.replace(/\s+/g, " ").trim();
      return ownText === matcher;
    }) ?? null
  );
}

export function findAllByText(container: HTMLElement, text: string): HTMLElement[] {
  const matcher = text.trim();
  return Array.from(container.querySelectorAll<HTMLElement>("*")).filter((element) => {
    const ownText = element.textContent?.replace(/\s+/g, " ").trim();
    return ownText === matcher;
  });
}

export function clickElement(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
