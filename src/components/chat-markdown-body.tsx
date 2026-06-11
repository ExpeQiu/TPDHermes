"use client";

import type { Components } from "react-markdown";
import { Children, cloneElement, isValidElement, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitTextWithCitationPlaceholders } from "@/lib/chat-citations";
import { accentLink } from "@/lib/theme-text";

function renderTextWithCitations(
  text: string,
  keyPrefix: string,
  renderCitation?: (ref: number) => ReactNode,
): ReactNode {
  if (!renderCitation || !text.includes("{{CITE:")) {
    return text;
  }
  const segments = splitTextWithCitationPlaceholders(text);
  if (segments.length === 1 && segments[0]?.kind === "text") {
    return text;
  }
  return (
    <>
      {segments.map((seg, idx) =>
        seg.kind === "text" ? (
          <span key={`${keyPrefix}-t-${idx}`}>{seg.value}</span>
        ) : (
          <span key={`${keyPrefix}-c-${idx}`}>{renderCitation(seg.ref)}</span>
        ),
      )}
    </>
  );
}

/** react-markdown v10 不暴露 text 节点组件，需在块级/行内子树中递归替换占位符。 */
function injectCitationsInChildren(
  children: ReactNode,
  renderCitation?: (ref: number) => ReactNode,
  keyPrefix = "inj",
): ReactNode {
  if (!renderCitation) return children;
  return Children.map(children, (child, index) => {
    if (typeof child === "string") {
      return renderTextWithCitations(child, `${keyPrefix}-${index}`, renderCitation);
    }
    if (typeof child === "number") {
      return child;
    }
    if (isValidElement(child)) {
      const props = child.props as { children?: ReactNode };
      if (props.children != null) {
        return cloneElement(
          child,
          { key: child.key ?? `${keyPrefix}-el-${index}` },
          injectCitationsInChildren(props.children, renderCitation, `${keyPrefix}-${index}`),
        );
      }
    }
    return child;
  });
}

function withInlineCitations(
  children: ReactNode,
  renderCitation?: (ref: number) => ReactNode,
): ReactNode {
  return injectCitationsInChildren(children, renderCitation);
}

function buildMarkdownComponents(renderCitation?: (ref: number) => ReactNode): Components {
  return {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 border-b border-slate-300 pb-1 text-base font-bold tracking-tight text-slate-900 first:mt-0 dark:border-slate-600 dark:text-slate-50">
      {withInlineCitations(children, renderCitation)}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3.5 mb-2 text-sm font-semibold text-slate-800 first:mt-0 dark:text-slate-100">
      {withInlineCitations(children, renderCitation)}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200 first:mt-0">
      {withInlineCitations(children, renderCitation)}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2.5 mb-1 text-sm font-medium text-slate-800 dark:text-slate-200 first:mt-0">
      {withInlineCitations(children, renderCitation)}
    </h4>
  ),
  p: ({ children }) => (
    <p className="mb-2.5 last:mb-0 leading-relaxed">{withInlineCitations(children, renderCitation)}</p>
  ),
  ul: ({ children }) => <ul className="mb-2.5 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2.5 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>,
  li: ({ children }) => (
    <li className="pl-0.5 leading-relaxed">{withInlineCitations(children, renderCitation)}</li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-slate-900 dark:text-slate-50">
      {withInlineCitations(children, renderCitation)}
    </strong>
  ),
  em: ({ children }) => <em className="italic">{withInlineCitations(children, renderCitation)}</em>,
  hr: () => <hr className="my-4 border-slate-300 dark:border-slate-600" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-slate-400 pl-3 text-slate-600 italic dark:border-slate-500 dark:text-slate-400">
      {withInlineCitations(children, renderCitation)}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className={`font-medium underline decoration-blue-700/40 underline-offset-2 dark:decoration-blue-400/40 ${accentLink}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const isFenced = typeof className === "string" && className.includes("language-");
    if (!isFenced) {
      return (
        <code
          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.9em] text-blue-700 dark:bg-slate-900/90 dark:text-blue-200"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-slate-300 dark:border-slate-600/80 bg-slate-50 dark:bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-slate-300 dark:border-slate-600">
      <table className="w-full min-w-[12rem] border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-100 dark:bg-slate-950/80 text-slate-700 dark:text-slate-300">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-slate-600">{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th className="border-b border-slate-300 dark:border-slate-600 px-2 py-1.5 font-semibold">
      {withInlineCitations(children, renderCitation)}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1.5 align-top text-slate-700 dark:text-slate-300">
      {withInlineCitations(children, renderCitation)}
    </td>
  ),
  };
}

export function ChatMarkdownBody({
  content,
  renderCitation,
}: {
  content: string;
  renderCitation?: (ref: number) => ReactNode;
}) {
  const components = useMemo(() => buildMarkdownComponents(renderCitation), [renderCitation]);
  return (
    <div className="text-sm leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
