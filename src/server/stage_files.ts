// The stage files: Claude Code agent files named stage-<id>.md in one folder, read and written with their frontmatter,
// keys X-Dev does not know kept as they were, so Claude Code and X-Dev run the same stages.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Document, parseDocument } from "yaml";

import {
  check_stage,
  default_max_proposals,
  done,
  efforts,
  label_of_id,
  sort_stages,
  stage_file_name,
  stage_id_of_file,
  type Effort,
  type Stage,
  type StageInput,
  type StageProblem,
  type StagesMethods,
} from "../shared/stages/model.ts";
import { default_stages } from "./default_stages.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

interface StageFile {
  frontmatter: Document;
  prompt: string;
}

const frontmatter_pattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parse_stage_file(text: string): StageFile {
  const match = frontmatter_pattern.exec(text);
  if (!match) throw new Error("it does not start with a frontmatter block between --- lines");
  const frontmatter = parseDocument(match[1]!);
  if (frontmatter.errors.length) throw new Error(`its frontmatter is not valid YAML: ${frontmatter.errors[0]!.message}`);
  if (frontmatter.contents !== null && !(frontmatter.toJS() instanceof Object)) throw new Error("its frontmatter is not a set of keys");
  return { frontmatter, prompt: match[2]!.trim() };
}

function text_of(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

// Claude Code takes tools as a comma-separated line; a list is read too.
function list_of(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text_of).filter(Boolean);
  return text_of(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function stage_of_file(id: string, file: StageFile): Stage {
  const keys = (file.frontmatter.toJS() ?? {}) as Record<string, unknown>;
  const effort = text_of(keys.effort);
  const order = Number(keys["x-dev-order"]);
  const max_proposals = Number(keys["x-dev-max-proposals"] ?? default_max_proposals);
  return {
    id,
    label: text_of(keys["x-dev-label"]) || label_of_id(id),
    description: text_of(keys.description),
    order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
    next: text_of(keys["x-dev-next"]) || done,
    model: text_of(keys.model),
    effort: efforts.includes(effort as Effort) ? (effort as Effort) : "",
    gates: list_of(keys["x-dev-gates"]),
    max_proposals: Number.isInteger(max_proposals) && max_proposals >= 0 ? max_proposals : default_max_proposals,
    paths: list_of(keys["x-dev-paths"]),
    tools: list_of(keys.tools),
    disallowed_tools: list_of(keys.disallowedTools),
    prompt: file.prompt,
  };
}

// ── Writing ──────────────────────────────────────────────────────────────────

function set_or_drop(document: Document, key: string, value: unknown): void {
  const is_empty = value === "" || (Array.isArray(value) && value.length === 0);
  if (is_empty) document.delete(key);
  else document.set(key, value);
}

// The file's text with the stage's fields set, every other key and comment kept.
export function write_stage_file(stage: Stage, previous: Document | null): string {
  const document = previous ?? new Document({});
  document.set("name", `stage-${stage.id}`);
  set_or_drop(document, "description", stage.description);
  set_or_drop(document, "model", stage.model);
  set_or_drop(document, "effort", stage.effort);
  set_or_drop(document, "tools", stage.tools.join(", "));
  set_or_drop(document, "disallowedTools", stage.disallowed_tools.join(", "));
  document.set("x-dev-label", stage.label);
  document.set("x-dev-order", stage.order);
  document.set("x-dev-next", stage.next);
  set_or_drop(document, "x-dev-gates", stage.gates);
  document.set("x-dev-max-proposals", stage.max_proposals);
  set_or_drop(document, "x-dev-paths", stage.paths);
  return `---\n${String(document).trimEnd()}\n---\n\n${stage.prompt.trim()}\n`;
}

// ── Folder ───────────────────────────────────────────────────────────────────

export interface StageFilesOptions {
  folder: string;
  // Told when a stage file changed, here or in another program.
  on_change?: () => void;
}

export interface StageFiles {
  methods: StagesMethods;
  // Follows the folder for changes made elsewhere; gives back the function that stops.
  watch: () => () => void;
}

const watch_settle_ms = 300;

export function create_stage_files({ folder, on_change = () => undefined }: StageFilesOptions): StageFiles {
  const path_of = (id: string): string => join(folder, stage_file_name(id));

  function read_all(): { stages: Stage[]; files: Map<string, StageFile>; problems: StageProblem[] } {
    const files = new Map<string, StageFile>();
    const problems: StageProblem[] = [];
    const names = existsSync(folder) ? readdirSync(folder).sort() : [];
    for (const name of names) {
      const id = stage_id_of_file(name);
      if (!id) continue;
      try {
        files.set(id, parse_stage_file(readFileSync(join(folder, name), "utf8")));
      } catch (error) {
        problems.push({ file: name, problem: (error as Error).message });
      }
    }
    const stages = sort_stages([...files].map(([id, file]) => stage_of_file(id, file)));
    return { stages, files, problems };
  }

  // Written beside the file and moved over it, so a reader never sees half a file.
  function write(stage: Stage, previous: Document | null): void {
    mkdirSync(folder, { recursive: true });
    const target = path_of(stage.id);
    const temporary = `${target}.x-dev-saving`;
    writeFileSync(temporary, write_stage_file(stage, previous));
    renameSync(temporary, target);
  }

  // Numbers the stages 1, 2, 3 in the order given, writing only the files whose number changed.
  function renumber(stages: Stage[], files: Map<string, StageFile>): void {
    stages.forEach((stage, index) => {
      if (stage.order !== index + 1) write({ ...stage, order: index + 1 }, files.get(stage.id)?.frontmatter ?? null);
    });
  }

  const methods: StagesMethods = {
    list_stages: () => {
      const { stages, problems } = read_all();
      return { folder, stages, problems };
    },
    get_stage: (id: string) => {
      const found = read_all().stages.find((stage) => stage.id === id);
      if (!found) throw new Error(`no stage ${id}`);
      return found;
    },
    save_stage: (input: StageInput, original_id: string | null) => {
      const { stages, files } = read_all();
      const existing = original_id === null ? undefined : stages.find((stage) => stage.id === original_id);
      if (original_id !== null && !existing) throw new Error(`no stage ${original_id}`);
      const other_ids = stages.map((stage) => stage.id).filter((id) => id !== original_id);
      const checked = check_stage(input, other_ids);
      const order = existing?.order ?? Math.max(0, ...stages.filter((stage) => stage.order !== Number.MAX_SAFE_INTEGER).map((stage) => stage.order)) + 1;
      write({ ...checked, order }, existing ? (files.get(existing.id)?.frontmatter ?? null) : null);
      if (existing && existing.id !== checked.id) {
        rmSync(path_of(existing.id));
        // Stages that came after the old id now come after the new one.
        for (const stage of stages) if (stage.next === existing.id && stage.id !== existing.id) write({ ...stage, next: checked.id }, files.get(stage.id)!.frontmatter);
      }
      on_change();
    },
    delete_stage: (id: string) => {
      const { stages, files } = read_all();
      const stage = stages.find((each) => each.id === id);
      if (!stage) throw new Error(`no stage ${id}`);
      rmSync(path_of(id));
      // A stage that came before it now goes where it went.
      const rest = stages.filter((each) => each.id !== id).map((each) => (each.next === id ? { ...each, next: stage.next } : each));
      for (const each of rest) if (each.next === stage.next && stages.find((old) => old.id === each.id)!.next === id) write(each, files.get(each.id)!.frontmatter);
      renumber(rest, files);
      on_change();
    },
    move_stage: (id: string, delta: -1 | 1) => {
      const { stages, files } = read_all();
      const index = stages.findIndex((stage) => stage.id === id);
      if (index < 0) throw new Error(`no stage ${id}`);
      const target = index + delta;
      if (target < 0 || target >= stages.length) return;
      const moved = [...stages];
      [moved[index], moved[target]] = [moved[target]!, moved[index]!];
      renumber(moved, files);
      on_change();
    },
    add_default_stages: () => {
      const { stages, files } = read_all();
      const present = new Set(stages.map((stage) => stage.id));
      const missing = default_stages.filter((stage) => !present.has(stage.id));
      const unreadable = new Set(missing.filter((stage) => existsSync(path_of(stage.id))).map((stage) => stage.id));
      const to_write = missing.filter((stage) => !unreadable.has(stage.id));
      const start = stages.length;
      to_write.forEach((stage, index) => write({ ...stage, order: start + index + 1 }, null));
      if (to_write.length) {
        renumber([...stages, ...to_write.map((stage, index) => ({ ...stage, order: start + index + 1 }))], files);
        on_change();
      }
      return to_write.length;
    },
  };

  return {
    methods,
    watch: () => {
      mkdirSync(folder, { recursive: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(folder, (_event, name) => {
        if (name !== null && !stage_id_of_file(String(name))) return;
        clearTimeout(timer);
        timer = setTimeout(on_change, watch_settle_ms);
      });
      return () => {
        clearTimeout(timer);
        watcher.close();
      };
    },
  };
}
