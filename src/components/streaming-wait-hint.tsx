type Props = {
  text: string;
  className?: string;
};

export function StreamingWaitHint({ text, className }: Props) {
  return (
    <p
      className={`text-sm leading-relaxed text-slate-600 dark:text-slate-300 ${className ?? ""}`}
      role="status"
      aria-live="polite"
    >
      {text}
      <span className="inline-block animate-pulse text-blue-500 dark:text-blue-400"> … …</span>
    </p>
  );
}
