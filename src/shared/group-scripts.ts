export type ScriptEntry = [string, string]; // [name, command]

/** Nested colon-prefix group (or a standalone leaf). */
export interface ScriptTreeNode {
  /** Full prefix path, e.g. `test:agent:memory`. */
  path: string;
  /** Display label (last segment), e.g. `memory`. */
  label: string;
  /** Exact script at this path, if one exists. */
  script: ScriptEntry | null;
  /** Nested groups / leaves. */
  children: ScriptTreeNode[];
}

interface TrieNode {
  segment: string;
  path: string;
  script: ScriptEntry | null;
  children: Map<string, TrieNode>;
  order: number;
}

/**
 * Build a nested tree from `a:b:c` script names.
 * Intermediate nodes are kept only when they organize 2+ scripts;
 * singleton paths stay flat leaves.
 */
export function groupScripts(scripts: ScriptEntry[]): ScriptTreeNode[] {
  const root: TrieNode = {
    segment: "",
    path: "",
    script: null,
    children: new Map(),
    order: 0,
  };
  let order = 0;

  for (const [name, command] of scripts) {
    const segments = name.split(":").filter((s) => s.length > 0);
    if (segments.length === 0) continue;

    let node = root;
    let path = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      path = path ? `${path}:${seg}` : seg;
      let child = node.children.get(seg);
      if (!child) {
        child = {
          segment: seg,
          path,
          script: null,
          children: new Map(),
          order: order++,
        };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.script = [name, command];
  }

  return emitChildren(root);
}

function scriptCount(node: TrieNode): number {
  let n = node.script ? 1 : 0;
  for (const child of node.children.values()) {
    n += scriptCount(child);
  }
  return n;
}

function emitChildren(node: TrieNode): ScriptTreeNode[] {
  const groups: ScriptTreeNode[] = [];
  const leaves: ScriptTreeNode[] = [];

  for (const child of node.children.values()) {
    const count = scriptCount(child);
    if (count <= 1) {
      const leaf = findSoleScript(child);
      if (leaf) {
        leaves.push({
          path: leaf[0],
          label: leaf[0],
          script: leaf,
          children: [],
        });
      }
      continue;
    }

    groups.push({
      path: child.path,
      label: child.segment,
      script: child.script,
      children: emitChildren(child),
    });
  }

  const byLabel = (a: ScriptTreeNode, b: ScriptTreeNode) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

  groups.sort(byLabel);
  leaves.sort(byLabel);
  return [...groups, ...leaves];
}

function findSoleScript(node: TrieNode): ScriptEntry | null {
  if (node.script && node.children.size === 0) return node.script;
  if (node.script && node.children.size > 0) return node.script;
  if (node.children.size === 1) {
    return findSoleScript([...node.children.values()][0]);
  }
  if (node.script) return node.script;
  for (const child of node.children.values()) {
    const found = findSoleScript(child);
    if (found) return found;
  }
  return null;
}

export function scriptGroupKey(packageName: string, path: string): string {
  return `${packageName}::${path}`;
}

function findNode(
  nodes: ScriptTreeNode[],
  groupPath: string
): ScriptTreeNode | null {
  for (const n of nodes) {
    if (n.path === groupPath) return n;
    const found = findNode(n.children, groupPath);
    if (found) return found;
  }
  return null;
}

function walkScripts(node: ScriptTreeNode): ScriptEntry[] {
  const out: ScriptEntry[] = [];
  if (node.script) out.push(node.script);
  for (const child of node.children) {
    out.push(...walkScripts(child));
  }
  return out;
}

/**
 * Collect scripts under a colon group in UI order (nested sections first, alpha).
 * Includes the group's own script if present, then descendants.
 */
export function collectGroupScripts(
  scripts: ScriptEntry[],
  groupPath: string
): ScriptEntry[] {
  const tree = groupScripts(scripts);
  const node = findNode(tree, groupPath);
  if (node) return walkScripts(node);

  // Fallback for flat prefixes that never became a tree node.
  return scripts
    .filter(
      ([name]) => name === groupPath || name.startsWith(`${groupPath}:`)
    )
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
