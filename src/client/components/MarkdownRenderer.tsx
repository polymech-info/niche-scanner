import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function plainText(children: React.ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) return children.map(plainText).join("");
  if (React.isValidElement(children)) {
    return plainText((children.props as { children?: React.ReactNode }).children);
  }
  return "";
}

function displayUrl(url: string): string {
  const value = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return value.length > 56 ? `${value.slice(0, 53)}...` : value;
}

export function MarkdownRenderer({ content }: { content: string }) {
  const markdown = useMemo(() => stripFrontmatter(content), [content]);

  return (
    <article
      className="max-w-[900px] mx-auto px-5 py-7 md:px-8 md:py-9 text-sm leading-7"
      style={{ color: "var(--color-text-secondary)" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children, ...props }) => (
            <h1
              id={slugify(plainText(children))}
              className="text-2xl font-semibold tracking-tight mb-5"
              style={{ color: "var(--color-text)" }}
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              id={slugify(plainText(children))}
              className="text-lg font-semibold tracking-tight mt-9 mb-3"
              style={{
                color: "var(--color-text)",
                borderBottom: "1px solid var(--color-border)",
                paddingBottom: 8,
              }}
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3
              id={slugify(plainText(children))}
              className="text-base font-semibold mt-7 mb-2"
              style={{ color: "var(--color-text)" }}
              {...props}
            >
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4
              id={slugify(plainText(children))}
              className="text-sm font-semibold mt-6 mb-2"
              style={{ color: "var(--color-text)" }}
              {...props}
            >
              {children}
            </h4>
          ),
          p: (props) => <p className="my-3" {...props} />,
          ul: (props) => <ul className="my-3 ml-5 list-disc space-y-1" {...props} />,
          ol: (props) => <ol className="my-3 ml-5 list-decimal space-y-1" {...props} />,
          li: (props) => <li className="pl-1" {...props} />,
          strong: (props) => (
            <strong className="font-semibold" style={{ color: "var(--color-text)" }} {...props} />
          ),
          blockquote: (props) => (
            <blockquote
              className="my-4 pl-4"
              style={{
                borderLeft: "3px solid var(--color-accent)",
                color: "var(--color-muted)",
              }}
              {...props}
            />
          ),
          a: ({ href, children, ...props }) => {
            if (!href) return <span>{children}</span>;
            const external = /^https?:\/\//.test(href);
            const text = plainText(children);
            const autoLink =
              text === href ||
              text.replace(/^https?:\/\//, "") === href.replace(/^https?:\/\//, "");
            return (
              <a
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
                className="text-runny-accent underline hover:no-underline"
                {...props}
              >
                {autoLink ? displayUrl(href) : children}
              </a>
            );
          },
          table: (props) => (
            <div className="overflow-x-auto my-5">
              <table
                className="min-w-full text-xs border-collapse"
                style={{ border: "1px solid var(--color-border)" }}
                {...props}
              />
            </div>
          ),
          th: (props) => (
            <th
              className="px-3 py-2 text-left font-semibold"
              style={{
                color: "var(--color-text)",
                background: "var(--color-panel)",
                border: "1px solid var(--color-border)",
              }}
              {...props}
            />
          ),
          td: (props) => (
            <td
              className="px-3 py-2 align-top"
              style={{ border: "1px solid var(--color-border)" }}
              {...props}
            />
          ),
          code: ({ className, children, ...props }) => (
            <code
              className={`${className ?? ""} font-mono text-xs px-1 py-0.5`}
              style={{
                background: "var(--color-panel)",
                borderRadius: 3,
                color: "var(--color-text)",
              }}
              {...props}
            >
              {children}
            </code>
          ),
          pre: ({ children, ...props }) => (
            <pre
              className="my-4 p-4 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-6"
              style={{
                background: "var(--color-panel)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
              }}
              {...props}
            >
              {children}
            </pre>
          ),
          hr: () => (
            <hr className="my-7" style={{ borderColor: "var(--color-border)" }} />
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
