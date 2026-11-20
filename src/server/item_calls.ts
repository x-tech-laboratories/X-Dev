// Adding an item as the New item form does, in one call the page, the API and MCP share.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { AddedItem, RunnerMethods } from "../shared/runs/runner.ts";
import { bind_methods } from "../shared/store.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

export interface ItemCallOptions {
  database: () => SqlDatabase;
  // Runs after each change, so history records it and the pages hear of it.
  after_write: () => void;
  runner: Pick<RunnerMethods, "get_runner" | "add_repository" | "link_issue">;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function create_item_calls({ database, after_write, runner }: ItemCallOptions): Pick<RunnerMethods, "add_item" | "take_proposal"> {
  const store = bind_methods(database, after_write);

  // The issue linked or opened, or why it could not be; the item stays saved either way.
  async function link(id: string): Promise<Pick<AddedItem, "issue" | "problem">> {
    try {
      return { issue: await runner.link_issue(id), problem: "" };
    } catch (error) {
      return { issue: null, problem: describe(error) };
    }
  }

  return {
    add_item: async ({ checkout: given_checkout, ...input }) => {
      const named = input.repository?.trim() ?? "";
      // A folder in place of owner/name is the checkout, its repository read from its remote.
      const checkout = given_checkout?.trim() || (named.startsWith("/") ? named : "");
      let repository = named.startsWith("/") ? "" : named;
      const known = Object.keys(runner.get_runner().settings.repositories).some((name) => name.toLowerCase() === repository.toLowerCase());
      let checkout_added = false;
      if (checkout && !known) {
        const added = await runner.add_repository(checkout);
        if (repository && added.toLowerCase() !== repository.toLowerCase()) throw new Error(`that checkout is of ${added}, not ${repository}`);
        repository = added;
        checkout_added = true;
      }
      const id = store.save_item({ ...input, repository });
      return { id, repository, checkout_added, ...(input.issue_number ? { issue: null, problem: "" } : await link(id)) };
    },
    take_proposal: async (id) => {
      store.accept_proposal(id);
      return { id, repository: store.get_item(id).repository, checkout_added: false, ...(await link(id)) };
    },
  };
}
