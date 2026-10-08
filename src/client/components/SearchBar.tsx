import React from "react";
import { Search } from "lucide-react";
import { useStore } from "../store/scripts";

export function SearchBar() {
  const searchQuery = useStore((s) => s.searchQuery);
  const setSearchQuery = useStore((s) => s.setSearchQuery);

  return (
    <div className="relative px-3 py-3">
      <Search
        size={14}
        className="absolute left-6 top-1/2 -translate-y-1/2"
        style={{ color: "var(--color-muted)" }}
      />
      <input
        type="text"
        placeholder="Search — fuzzy, camel, : - _ …"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="w-full rounded-md pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-runny-accent"
        title="Matches substrings, camelCase/separator words, acronyms (tma → test:media:api), and fuzzy sequences"
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text)",
        }}
      />
    </div>
  );
}
