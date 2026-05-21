"use client";

import { useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type KbMarkdownAssetContext,
  resolveKbMarkdownAssetUrl,
} from "@/lib/kb-markdown-assets";

const proseComponents: Components = {
  img: ({ src, alt, ...props }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      src={src}
      alt={alt ?? ""}
      className="max-w-full rounded-md border border-slate-300 dark:border-slate-700/80 my-2"
      loading="lazy"
      decoding="async"
    />
  ),
};

export function KbMarkdown({
  children,
  assetContext,
  className,
}: {
  children: string;
  assetContext?: KbMarkdownAssetContext;
  className?: string;
}) {
  const components = useMemo<Components>(() => {
    const ctx = assetContext;
    return {
      ...proseComponents,
      img: ({ src, alt, ...props }) => {
        const resolved = resolveKbMarkdownAssetUrl(
          typeof src === "string" ? src : undefined,
          ctx,
        );
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            {...props}
            src={resolved}
            alt={alt ?? ""}
            className="max-w-full rounded-md border border-slate-300 dark:border-slate-700/80 my-2"
            loading="lazy"
            decoding="async"
          />
        );
      },
    };
  }, [assetContext]);

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}


